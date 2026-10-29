import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConnectionsFormat,
  Decrypter,
  Encrypter,
  PassphraseError,
  PortableConnection,
  SecretsMode,
  colorFrom,
  detectFormat,
  hostOf,
  isEncrypted,
  lacksPassword,
  parseConnections,
  parseList,
  serializeConnections,
  setUriParams,
  tlsFromUri,
  tlsIntoUri,
  uniqueName,
  urlPassword,
  withPassword,
} from '../../src/shared/connectionsFile';

/** Encrypts as Compass's encrypt.ts does, independently of Encrypter: version ‖ salt ‖ iv ‖ tag ‖ ciphertext. */
function compassEncrypt(passphrase: string, plaintext: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 100_000, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([0x00, 0x01]), salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

const compassFile = (connections: unknown[]) => JSON.stringify({ type: 'Compass Connections', version: { $numberInt: '1' }, connections });

describe('connection strings', () => {
  it('reads and replaces the password of any URL, percent-encoded as written', () => {
    expect(urlPassword('mongodb://ada:p%40ss@h:27017/db')).toBe('p%40ss');
    expect(urlPassword('mongodb://ada@h')).toBeUndefined();
    expect(urlPassword('mongodb://h')).toBeUndefined();
    expect(withPassword('mongodb://ada:old@h/db', 'new')).toBe('mongodb://ada:new@h/db');
    expect(withPassword('mongodb://ada:old@h/db', undefined)).toBe('mongodb://ada@h/db');
    expect(withPassword('mongodb://ada@h/db', 'pw')).toBe('mongodb://ada:pw@h/db');
  });

  it('keeps a password without a user, as redis://:password@host', () => {
    expect(withPassword('redis://cache:6379/0', 's3cret')).toBe('redis://:s3cret@cache:6379/0');
    expect(urlPassword('redis://:s3cret@cache:6379/0')).toBe('s3cret');
    expect(withPassword('redis://:s3cret@cache:6379/0', undefined)).toBe('redis://cache:6379/0');
    expect(withPassword('redis://:s3cret@cache:6379/0', 'other')).toBe('redis://:other@cache:6379/0');
  });

  it('names a connection after its hosts, without credentials', () => {
    expect(hostOf('mongodb://u:p@a:1,b:2/db?x=1')).toBe('a:1,b:2');
    expect(hostOf('mongodb+srv://cluster0.abc.mongodb.net/')).toBe('cluster0.abc.mongodb.net');
    expect(hostOf('nope')).toBe('MongoDB');
  });

  it('sets and removes options, keeping the others as written', () => {
    expect(setUriParams('mongodb://h/db?a=1&B=2', { b: '3', c: undefined, d: 'x y' })).toBe('mongodb://h/db?a=1&b=3&d=x%20y');
    expect(setUriParams('mongodb://h/db?a=1', { a: undefined })).toBe('mongodb://h/db');
    expect(setUriParams('mongodb://u:p@h', { tls: 'true' })).toBe('mongodb://u:p@h/?tls=true');
  });

  it('knows when a user has no password', () => {
    expect(lacksPassword('mongodb://ada@h')).toBe(true);
    expect(lacksPassword('mongodb://ada:pw@h')).toBe(false);
    expect(lacksPassword('mongodb://h')).toBe(false);
    expect(lacksPassword('mongodb://CN=me@h/?authMechanism=MONGODB-X509')).toBe(false);
  });
});

describe('TLS options', () => {
  it('moves the certificate files and their options out of the connection string', () => {
    const { uri, tls } = tlsFromUri(
      'mongodb://h:27017/db?tls=true&tlsCAFile=C%3A%5Ccerts%5Cca.pem&tlsCertificateKeyFile=%2Fk.pem&tlsCertificateKeyFilePassword=kp&tlsAllowInvalidHostnames=true&appName=x',
    );
    expect(uri).toBe('mongodb://h:27017/db?appName=x');
    expect(tls).toEqual({ caFile: 'C:\\certs\\ca.pem', certificateKeyFile: '/k.pem', certificateKeyFilePassword: 'kp', allowInvalidHostnames: true });
    expect(tlsFromUri('mongodb://h/?ssl=true&tlsCAFile=ca.pem&tlsInsecure=true').tls).toEqual({
      caFile: 'ca.pem',
      allowInvalidCertificates: true,
      allowInvalidHostnames: true,
    });
  });

  it('leaves the string as it is without files, or with TLS off', () => {
    expect(tlsFromUri('mongodb://h/?tls=true&tlsAllowInvalidCertificates=true')).toEqual({ uri: 'mongodb://h/?tls=true&tlsAllowInvalidCertificates=true' });
    expect(tlsFromUri('mongodb://h/?tls=false&tlsCAFile=ca.pem')).toEqual({ uri: 'mongodb://h/?tls=false&tlsCAFile=ca.pem' });
  });

  it('writes the TLS settings back into a string, the key password only with the secrets', () => {
    const tls = { caFile: 'ca.pem', certificateKeyFile: 'k.pem', certificateKeyFilePassword: 'kp', allowInvalidCertificates: true };
    expect(tlsIntoUri('mongodb://h/db?ssl=true', tls, true)).toBe(
      'mongodb://h/db?tls=true&tlsCAFile=ca.pem&tlsCertificateKeyFile=k.pem&tlsCertificateKeyFilePassword=kp&tlsAllowInvalidCertificates=true',
    );
    expect(tlsIntoUri('mongodb://h/db', tls, false)).not.toContain('kp');
    expect(tlsIntoUri('mongodb://h/db', undefined, true)).toBe('mongodb://h/db');
    expect(tlsFromUri(tlsIntoUri('mongodb://h/db?w=1', tls, true))).toEqual({ uri: 'mongodb://h/db?w=1', tls });
  });
});

describe('colorFrom', () => {
  it("maps Compass's color codes and names", () => {
    expect(colorFrom('color1')).toBe('green');
    expect(colorFrom('color2')).toBe('green');
    expect(colorFrom('color3')).toBe('blue');
    expect(colorFrom('color6')).toBe('red');
    expect(colorFrom('color8')).toBe('orange');
    expect(colorFrom('color9')).toBe('yellow');
    expect(colorFrom('color10')).toBeUndefined();
    expect(colorFrom('teal')).toBe('green');
    expect(colorFrom('pink')).toBe('purple');
  });

  it("keeps Mongoster's colors, maps hex colors to the closest hue and grays to none", () => {
    expect(colorFrom(' Blue ')).toBe('blue');
    expect(colorFrom('#ff0000')).toBe('red');
    expect(colorFrom('#00f')).toBe('blue');
    expect(colorFrom('ffa500')).toBe('orange');
    expect(colorFrom('#808080')).toBeUndefined();
    expect(colorFrom('#xyz')).toBeUndefined();
    expect(colorFrom(3)).toBeUndefined();
    expect(colorFrom(undefined)).toBeUndefined();
  });
});

describe('encryption', () => {
  it('decrypts what Compass encrypts, and what Encrypter encrypts', async () => {
    const text = JSON.stringify({ secrets: { password: 'p@ss' } });
    expect(await new Decrypter('phrase').decrypt(compassEncrypt('phrase', text))).toBe(text);
    const e = new Encrypter('phrase');
    const one = await e.encrypt('first');
    const two = await e.encrypt('second');
    const raw = Buffer.from(one, 'base64');
    expect(raw.readUInt16BE(0)).toBe(1);
    // One salt for the file, a new IV for each value.
    expect(raw.subarray(2, 18)).toEqual(Buffer.from(two, 'base64').subarray(2, 18));
    expect(raw.subarray(18, 34)).not.toEqual(Buffer.from(two, 'base64').subarray(18, 34));
    const d = new Decrypter('phrase');
    expect([await d.decrypt(one), await d.decrypt(two)]).toEqual(['first', 'second']);
  });

  it('rejects a wrong passphrase, and damaged or unknown data', async () => {
    const data = compassEncrypt('right', 'x');
    await expect(new Decrypter('wrong').decrypt(data)).rejects.toBeInstanceOf(PassphraseError);
    await expect(new Decrypter('right').decrypt('AAE=')).rejects.toThrow('too short');
    const other = Buffer.from(data, 'base64');
    other.writeUInt16BE(2, 0);
    await expect(new Decrypter('right').decrypt(other.toString('base64'))).rejects.toThrow('Unknown encrypted data version: 0x2');
  });
});

describe('detectFormat', () => {
  it('tells the formats apart', () => {
    expect(detectFormat(compassFile([]))).toBe('compass');
    expect(detectFormat('\uFEFF{ "type": "Mongoster Connections", "version": 1, "connections": [] }')).toBe('mongoster');
    expect(detectFormat('mongodb://h\nmongodb://g')).toBe('list');
  });

  it('refuses other JSON files and invalid JSON', async () => {
    expect(() => detectFormat('{ "type": "Something" }')).toThrow('neither a Compass export');
    expect(() => detectFormat('{ "type": ')).toThrow('Not a valid JSON file');
    await expect(parseConnections('{ "type": "Compass Connections", "version": 2, "connections": [] }')).rejects.toThrow('Unsupported version');
    await expect(parseConnections('{ "type": "Compass Connections", "version": 1 }')).rejects.toThrow('no list of connections');
  });
});

describe('parseList', () => {
  it('reads one connection string per line, with or without a name', () => {
    const r = parseList(
      [
        '# my servers',
        '// also a comment',
        '',
        'mongodb://localhost:27017/app',
        'Production = mongodb+srv://ada:pw@cluster0.x.mongodb.net/shop?retryWrites=true',
        '"Quoted Name" = "mongodb://h1:27017/db",',
        "'Single': mongodb://h2/db;",
        'Tabbed\tmongodb://h3/db',
        'not a connection',
        'mongodb:// broken',
      ].join('\r\n'),
    );
    expect(r.format).toBe('list');
    expect(r.skipped).toBe(2);
    expect(r.connections.map((c) => [c.name, c.uri])).toEqual([
      ['localhost:27017', 'mongodb://localhost:27017/app'],
      ['Production', 'mongodb+srv://ada:pw@cluster0.x.mongodb.net/shop?retryWrites=true'],
      ['Quoted Name', 'mongodb://h1:27017/db'],
      ['Single', 'mongodb://h2/db'],
      ['Tabbed', 'mongodb://h3/db'],
    ]);
  });

  it('takes the TLS files out and notes a missing password', () => {
    const [c] = parseList('Secure = mongodb://ada@h/db?tls=true&tlsCAFile=%2Fca.pem').connections;
    expect(c).toEqual({ name: 'Secure', uri: 'mongodb://ada@h/db', tls: { caFile: '/ca.pem' }, notes: ['no password'] });
  });
});

describe('parseConnections: Compass', () => {
  const entry = {
    id: 'a1',
    favorite: { name: ' Prod ', color: 'color3' },
    savedConnectionType: 'favorite',
    connectionOptions: {
      connectionString: 'mongodb://admin:secret@db1:27017,db2:27017/?replicaSet=rs0&tls=true&tlsCAFile=%2Fca.pem',
      sshTunnel: { host: 'bastion', port: { $numberInt: '2222' }, username: 'ubuntu', identityKeyFile: ['/id_rsa'], identityKeyPassphrase: 'kp' },
      fleOptions: { storeCredentials: false, autoEncryption: { keyVaultNamespace: 'enc.keys' } },
    },
  };

  it('reads a plain export with its options', async () => {
    const r = await parseConnections(compassFile([entry, { id: 'b', connectionOptions: { connectionString: 'not a uri' } }, 'junk']));
    expect(r).toMatchObject({ format: 'compass', skipped: 2 });
    expect(r.connections).toEqual([
      {
        name: 'Prod',
        uri: 'mongodb://admin:secret@db1:27017,db2:27017/?replicaSet=rs0',
        tls: { caFile: '/ca.pem' },
        color: 'blue',
        ssh: { host: 'bastion', port: 2222, username: 'ubuntu', auth: 'privateKey', privateKeyFile: '/id_rsa', passphrase: 'kp' },
        notes: ['the SSH tunnel goes to the first host only', 'In-Use Encryption settings not imported'],
      },
    ]);
  });

  it('does not take an SSH tunnel for a mongodb+srv string', async () => {
    const r = await parseConnections(
      compassFile([{ favorite: {}, connectionOptions: { connectionString: 'mongodb+srv://c.x.net/', sshTunnel: { host: 'b', username: 'u', password: 'p' } } }]),
    );
    expect(r.connections[0]).toMatchObject({ name: 'c.x.net', uri: 'mongodb+srv://c.x.net/' });
    expect(r.connections[0].ssh).toBeUndefined();
    expect(r.connections[0].notes[0]).toMatch(/SSH tunnel not imported/);
  });

  const encrypted = () =>
    compassFile([
      {
        id: 'c',
        favorite: { name: 'Enc', color: '#ff0000' },
        connectionOptions: {
          connectionString: 'mongodb://admin@h:27017/?authSource=admin&tlsCertificateKeyFile=%2Fk.pem',
          sshTunnel: { host: 'jump', username: 'me' },
        },
        connectionSecrets: compassEncrypt('pass phrase', JSON.stringify({ secrets: { password: 'p%40ss', sshTunnelPassword: 'sshpw', tlsCertificateKeyFilePassword: 'kp' } })),
      },
    ]);

  it('decrypts the secrets of an export with a passphrase', async () => {
    expect(isEncrypted(encrypted())).toBe(true);
    const r = await parseConnections(encrypted(), 'pass phrase');
    expect(r.connections).toEqual([
      {
        name: 'Enc',
        uri: 'mongodb://admin:p%40ss@h:27017/?authSource=admin',
        tls: { certificateKeyFile: '/k.pem', certificateKeyFilePassword: 'kp' },
        color: 'red',
        ssh: { host: 'jump', username: 'me', auth: 'password', password: 'sshpw' },
        notes: [],
      },
    ]);
  });

  it('rejects a wrong passphrase, and leaves the secrets out without one', async () => {
    await expect(parseConnections(encrypted(), 'wrong')).rejects.toBeInstanceOf(PassphraseError);
    const r = await parseConnections(encrypted());
    expect(r.connections[0].uri).toBe('mongodb://admin@h:27017/?authSource=admin');
    expect(r.connections[0].ssh?.password).toBe('');
    expect(r.connections[0].notes).toEqual(['passwords not imported (encrypted)']);
  });

  it('merges an AWS session token into the mechanism properties', async () => {
    const file = compassFile([
      {
        connectionOptions: { connectionString: 'mongodb://key@h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:old' },
        connectionSecrets: compassEncrypt('x', JSON.stringify({ secrets: { awsSessionToken: 'tok' } })),
      },
    ]);
    const [c] = (await parseConnections(file, 'x')).connections;
    expect(c.uri).toBe('mongodb://key@h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN%3Atok');
    expect(c.notes).toEqual([]);
  });
});

describe('serializeConnections and back', () => {
  const full: PortableConnection = {
    name: 'Full',
    uri: 'mongodb://ada:p%40ss@db1:27017,db2:27017/app?replicaSet=rs0',
    folder: 'Work',
    color: 'orange',
    readOnly: true,
    noHistory: true,
    tls: { caFile: '/ca.pem', certificateKeyFile: '/k.pem', certificateKeyFilePassword: 'kp', allowInvalidHostnames: true },
    ssh: { host: 'jump', port: 2200, username: 'me', auth: 'password', password: 'sshpw' },
    redis: { url: 'redis://:r3dis@cache:6379/0', settings: { prefix: 'app:', namespaces: ['ns'], scope: ['app.*'] } },
    notes: [],
  };
  const keyed: PortableConnection = {
    name: 'Keyed',
    uri: 'mongodb://h:27017/db',
    color: 'purple',
    ssh: { host: 'jump2', username: 'u', auth: 'privateKey', privateKeyFile: '/id', passphrase: 'kpp' },
    notes: [],
  };
  const list = [full, keyed];
  const roundTrip = async (format: ConnectionsFormat, secrets: SecretsMode) => {
    const out = await serializeConnections(list, format, { secrets, passphrase: secrets === 'encrypt' ? 'correct horse' : undefined });
    return { out, parsed: await parseConnections(out.text, secrets === 'encrypt' ? 'correct horse' : undefined) };
  };

  it('keeps everything in Mongoster’s format, with the secrets in clear or encrypted', async () => {
    for (const mode of ['include', 'encrypt'] as const) {
      const { out, parsed } = await roundTrip('mongoster', mode);
      expect(parsed.format).toBe('mongoster');
      expect(parsed.connections, mode).toEqual(list);
      expect(isEncrypted(out.text)).toBe(mode === 'encrypt');
      expect(out.text.includes('r3dis'), mode).toBe(mode === 'include');
      expect(out.text.includes('sshpw'), mode).toBe(mode === 'include');
      expect(JSON.parse(out.text).secrets).toBe(mode === 'include' ? 'included' : 'encrypted');
    }
  });

  it('drops every secret from Mongoster’s format on request, and says what is missing', async () => {
    const { out, parsed } = await roundTrip('mongoster', 'remove');
    for (const secret of ['p%40ss', 'kp"', 'sshpw', 'r3dis', 'kpp']) expect(out.text).not.toContain(secret);
    const [a, b] = parsed.connections;
    expect(a.uri).toBe('mongodb://ada@db1:27017,db2:27017/app?replicaSet=rs0');
    expect(a.tls).toEqual({ caFile: '/ca.pem', certificateKeyFile: '/k.pem', allowInvalidHostnames: true });
    expect(a.redis).toEqual({ url: 'redis://cache:6379/0', settings: full.redis!.settings });
    expect(a.notes).toEqual(['no password', 'no SSH password']);
    expect(b.ssh).toEqual({ host: 'jump2', username: 'u', auth: 'privateKey', privateKeyFile: '/id' });
    expect(isEncrypted(out.text)).toBe(false);
  });

  it('keeps what Compass has in its format: passwords, TLS, SSH and colors', async () => {
    for (const mode of ['include', 'encrypt'] as const) {
      const { out, parsed } = await roundTrip('compass', mode);
      expect(parsed.format).toBe('compass');
      expect(out.notes).toEqual(["folders, read-only and redis-oplog were left out (Compass doesn't have them)"]);
      const { folder: _f, readOnly: _r, noHistory: _n, redis: _x, ...compassPart } = full;
      // A tunnel to several hosts goes to the first one only: the import says so.
      expect(parsed.connections, mode).toEqual([{ ...compassPart, notes: ['the SSH tunnel goes to the first host only'] }, keyed]);
      const json = JSON.parse(out.text);
      expect(json.connections[0].favorite).toEqual({ name: 'Full', color: 'color8' });
      if (mode === 'encrypt') {
        expect(json.connections[0].connectionOptions.connectionString).not.toContain('p%40ss');
        expect(json.connections[0].connectionOptions.connectionString).not.toContain('kp');
        expect(json.connections[0].connectionSecrets).toEqual(expect.any(String));
      }
    }
  });

  it('round-trips every color through Compass’s codes', async () => {
    const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
    const out = await serializeConnections(
      colors.map((color) => ({ name: color, uri: 'mongodb://h/db', color, notes: [] })),
      'compass',
      { secrets: 'remove' },
    );
    expect((await parseConnections(out.text)).connections.map((c) => c.color)).toEqual([...colors]);
  });

  it('drops the secrets from Compass’s format on request', async () => {
    const { out, parsed } = await roundTrip('compass', 'remove');
    for (const secret of ['p%40ss', 'sshpw', 'kpp']) expect(out.text).not.toContain(secret);
    expect(out.text).not.toContain('connectionSecrets');
    expect(parsed.connections[0].uri).toBe(withPassword(full.uri, undefined));
    expect(parsed.connections[0].tls).toEqual({ caFile: '/ca.pem', certificateKeyFile: '/k.pem', allowInvalidHostnames: true });
    expect(parsed.connections[0].notes).toEqual(['the SSH tunnel goes to the first host only', 'no password', 'no SSH password']);
  });

  it('writes a list of connection strings, with TLS in them and the rest left out', async () => {
    const { out, parsed } = await roundTrip('list', 'include');
    expect(out.text.split('\n')[1]).toBe(
      'Full = mongodb://ada:p%40ss@db1:27017,db2:27017/app?replicaSet=rs0&tls=true&tlsCAFile=%2Fca.pem&tlsCertificateKeyFile=%2Fk.pem&tlsCertificateKeyFilePassword=kp&tlsAllowInvalidHostnames=true',
    );
    expect(out.notes).toEqual(["2 SSH tunnels were left out (a connection string can't hold one)", 'folders, colors, read-only and redis-oplog were left out']);
    expect(parsed.connections).toEqual([
      { name: 'Full', uri: full.uri, tls: full.tls, notes: [] },
      { name: 'Keyed', uri: keyed.uri, notes: [] },
    ]);
    const removed = await roundTrip('list', 'remove');
    expect(removed.out.text).not.toContain('p%40ss');
    expect(removed.out.text).not.toContain('kp');
    expect(removed.parsed.connections[0]).toMatchObject({ uri: 'mongodb://ada@db1:27017,db2:27017/app?replicaSet=rs0', notes: ['no password'] });
  });

  it('refuses to encrypt a list or without a passphrase', async () => {
    await expect(serializeConnections(list, 'list', { secrets: 'encrypt', passphrase: 'x' })).rejects.toThrow("can't be encrypted");
    await expect(serializeConnections(list, 'mongoster', { secrets: 'encrypt' })).rejects.toThrow('A passphrase is needed');
  });

  it('rejects the wrong passphrase on a Mongoster file', async () => {
    const out = await serializeConnections(list, 'mongoster', { secrets: 'encrypt', passphrase: 'right' });
    await expect(parseConnections(out.text, 'wrong')).rejects.toBeInstanceOf(PassphraseError);
    const locked = await parseConnections(out.text);
    expect(locked.connections[0].uri).toBe('mongodb://ada@db1:27017,db2:27017/app?replicaSet=rs0');
    expect(locked.connections[0].redis?.url).toBe('redis://cache:6379/0');
    expect(locked.connections[0].notes).toEqual(['passwords not imported (encrypted)']);
  });

  it('notes that Compass cannot use the SSH agent', async () => {
    const out = await serializeConnections([{ name: 'a', uri: 'mongodb://h/db', ssh: { host: 'j', username: 'u', auth: 'agent' }, notes: [] }], 'compass', { secrets: 'include' });
    expect(out.notes).toEqual(["Compass can't use the SSH agent: those tunnels have no password or key"]);
  });
});

describe('uniqueName', () => {
  it('adds a number when the name is taken', () => {
    expect(uniqueName('a', new Set())).toBe('a');
    expect(uniqueName('a', new Set(['a']))).toBe('a (2)');
    expect(uniqueName('a', new Set(['a', 'a (2)']))).toBe('a (3)');
  });
});
