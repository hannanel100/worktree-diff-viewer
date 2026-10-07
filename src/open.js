import { spawn } from 'node:child_process';

/** Open a URL in the user's default browser without blocking the process. */
export function openInBrowser(url) {
  let cmd;
  let args;
  if (process.platform === 'win32') {
    // Encoded command sidesteps every quoting problem cmd.exe has with '&' and '#'.
    const script = `Start-Process "${url.replace(/"/g, '')}"`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
