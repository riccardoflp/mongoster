// The only door between the window and the main process: messages of the shell's protocol.
import { contextBridge, ipcRenderer } from 'electron';
import type { HostMessage, ShellBridge, ShellMessage } from './protocol';

const bridge: ShellBridge = {
  send: (message: ShellMessage) => ipcRenderer.send('shell', message),
  request: (name, args) => ipcRenderer.invoke('shell-request', name, args),
  onMessage: (listener) => {
    ipcRenderer.on('host', (_event, message: HostMessage) => listener(message));
  },
};

contextBridge.exposeInMainWorld('mongosterHost', bridge);
