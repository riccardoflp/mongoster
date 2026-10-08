// How a connection reaches the server: TLS certificates and an optional SSH tunnel (a local port forwarded
// through an SSH server to the first host of the connection string).
import * as fs from 'fs';
import * as net from 'net';
import { createHash } from 'crypto';
import { Client, ConnectConfig } from 'ssh2';
import { MongoClient, MongoClientOptions } from 'mongodb';

export interface TlsOptions {
  caFile?: string;
  certificateKeyFile?: string;
  certificateKeyFilePassword?: string;
  allowInvalidCertificates?: boolean;
  allowInvalidHostnames?: boolean;
}

export type SshAuth = 'password' | 'privateKey' | 'agent';

export interface SshOptions {
  host: string;
  port?: number;
  username: string;
  auth: SshAuth;
  password?: string;
  privateKeyFile?: string;
  passphrase?: string;
}

/** Stored with the connection string in the SecretStorage (it holds passwords). */
export interface ConnectionOptions {
  tls?: TlsOptions;
  ssh?: SshOptions;
}

/** Decides whether to trust the host key of an SSH server; `known` is the fingerprint trusted before, if any. */
export type HostKeyCheck = (host: string, fingerprint: string) => Promise<boolean>;

const SSH_TIMEOUT_MS = 15_000;
const DEFAULT_MONGO_PORT = 27017;

/** OpenSSH-style fingerprint of a host key: SHA256:base64 without padding. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** scheme, user info (with its @), host list, and the rest (/db?options). */
const URI_PARTS = /^(mongodb(?:\+srv)?:\/\/)([^@/?]*@)?([^/?]*)(.*)$/s;

/** The host and port the tunnel must reach: the first host of the connection string. */
export function tunnelTarget(uri: string): { host: string; port: number } {
  const parts = URI_PARTS.exec(uri.trim());
  if (!parts) throw new Error('The connection string must start with mongodb://');
  if (parts[1] === 'mongodb+srv://') {
    throw new Error('A mongodb+srv:// connection string can not go through an SSH tunnel: use the mongodb://host:port form of one of the servers.');
  }
  const first = parts[3].split(',')[0];
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(first) ?? /^([^:]+)(?::(\d+))?$/.exec(first);
  if (!m) throw new Error(`Unexpected host in the connection string: ${first || '(none)'}`);
  return { host: decodeURIComponent(m[1]), port: m[2] ? Number(m[2]) : DEFAULT_MONGO_PORT };
}

/** The connection string pointed at the local end of the tunnel, as a direct connection to that one server. */
export function throughTunnel(uri: string, localPort: number): string {
  const [, scheme, auth = '', , rest] = URI_PARTS.exec(uri.trim())!;
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));
  for (const key of [...params.keys()]) if (key.toLowerCase() === 'directconnection') params.delete(key);
  params.set('directConnection', 'true');
  return `${scheme}${auth}127.0.0.1:${localPort}${path || '/'}?${params.toString()}`;
}

export function tlsClientOptions(tls: TlsOptions | undefined): MongoClientOptions {
  if (!tls) return {};
  const options: MongoClientOptions = { tls: true };
  if (tls.caFile) options.tlsCAFile = tls.caFile;
  if (tls.certificateKeyFile) options.tlsCertificateKeyFile = tls.certificateKeyFile;
  if (tls.certificateKeyFilePassword) options.tlsCertificateKeyFilePassword = tls.certificateKeyFilePassword;
  if (tls.allowInvalidCertificates) options.tlsAllowInvalidCertificates = true;
  if (tls.allowInvalidHostnames) options.tlsAllowInvalidHostnames = true;
  return options;
}

function defaultAgent(): string | undefined {
  return process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
}

/** A local TCP port forwarded through an SSH connection to one host and port. */
export class SshTunnel {
  /** The last error of the SSH connection or of a forwarded connection, to explain a failed connect. */
  lastError?: string;
  private closed = false;
  private readonly closeListeners: (() => void)[] = [];

  private constructor(
    private readonly ssh: Client,
    private readonly server: net.Server,
    readonly port: number,
  ) {
    ssh.on('close', () => this.close());
    ssh.on('error', (err) => (this.lastError = err.message));
  }

  static async open(options: SshOptions, target: { host: string; port: number }, checkHostKey: HostKeyCheck): Promise<SshTunnel> {
    const ssh = new Client();
    const label = `${options.host}:${options.port ?? 22}`;
    const config: ConnectConfig = {
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
      readyTimeout: SSH_TIMEOUT_MS,
      keepaliveInterval: 30_000,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        checkHostKey(label, fingerprint(key)).then(verify, () => verify(false));
      },
    };
    if (options.auth === 'password') config.password = options.password ?? '';
    else if (options.auth === 'privateKey') {
      if (!options.privateKeyFile) throw new Error('SSH: no private key file.');
      try {
        config.privateKey = fs.readFileSync(options.privateKeyFile);
      } catch (err) {
        throw new Error(`SSH: can't read the private key ${options.privateKeyFile}: ${(err as Error).message}`);
      }
      if (options.passphrase) config.passphrase = options.passphrase;
    } else {
      const agent = defaultAgent();
      if (!agent) throw new Error('SSH: no SSH agent found (SSH_AUTH_SOCK is not set).');
      config.agent = agent;
    }

    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        ssh.removeListener('ready', ready);
        ssh.end();
        const reason = /All configured authentication methods failed/i.test(err.message)
          ? `authentication failed for ${options.username}@${label}`
          : /verification failed/i.test(err.message)
            ? `the host key of ${label} was not trusted`
            : err.message;
        reject(new Error(`SSH: ${reason}`));
      };
      const ready = () => {
        ssh.removeListener('error', fail);
        resolve();
      };
      ssh.once('ready', ready);
      ssh.once('error', fail);
      ssh.connect(config);
    });

    let tunnel: SshTunnel | undefined;
    const server = net.createServer((socket) => {
      ssh.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, target.host, target.port, (err, stream) => {
        if (err) {
          if (tunnel) tunnel.lastError = `${label} can't reach ${target.host}:${target.port} (${err.message})`;
          socket.destroy();
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        socket.on('error', () => stream.destroy());
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    tunnel = new SshTunnel(ssh, server, port);
    return tunnel;
  }

  /** Called once when the SSH connection ends (or the tunnel is closed). */
  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
    this.ssh.end();
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}

/** Connects a MongoClient with the TLS options and, when configured, through an SSH tunnel. */
export async function openClient(
  uri: string,
  options: ConnectionOptions | undefined,
  base: MongoClientOptions,
  checkHostKey: HostKeyCheck,
): Promise<{ client: MongoClient; tunnel?: SshTunnel }> {
  const clientOptions = { ...base, ...tlsClientOptions(options?.tls) };
  if (!options?.ssh) return { client: await new MongoClient(uri, clientOptions).connect() };
  const target = tunnelTarget(uri);
  const tunnel = await SshTunnel.open(options.ssh, target, checkHostKey);
  // With TLS the certificate is checked against the real host, not the local end of the tunnel.
  if (!net.isIP(target.host)) clientOptions.servername = target.host;
  try {
    const client = await new MongoClient(throughTunnel(uri, tunnel.port), clientOptions).connect();
    return { client, tunnel };
  } catch (err) {
    const reason = tunnel.lastError;
    tunnel.close();
    if (reason) throw new Error(`SSH tunnel: ${reason}`);
    throw err;
  }
}
