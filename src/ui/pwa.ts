import { $ } from './dom';

interface Host {
  readonly hasUnsavedWork: boolean;
  openFiles(files: File[], mode: 'replace' | 'append'): Promise<void>;
  confirm(title: string, body: string, ok: string): Promise<boolean>;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface LaunchParams { files: FileSystemFileHandle[] }

/**
 * Installation, offline caching and updates. A new version is downloaded in the background but
 * only takes over when the user clicks Reload - never in the middle of an editing session.
 */
export function setupPwa(host: Host): void {
  setupInstall();
  setupFileLaunch(host);
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || location.protocol === 'file:') return;
  window.addEventListener('load', async () => {
    let registration: ServiceWorkerRegistration;
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch {
      return;
    }
    const offer = (worker: ServiceWorker | null) => { if (worker && navigator.serviceWorker.controller) showUpdate(host, worker); };
    offer(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      incoming?.addEventListener('statechange', () => { if (incoming.state === 'installed') offer(incoming); });
    });
    // Long-lived sessions still learn about updates.
    setInterval(() => registration.update().catch(() => undefined), 60 * 60 * 1000);
  });
}

function showUpdate(host: Host, worker: ServiceWorker): void {
  const bar = $('update-bar');
  bar.hidden = false;
  $('update-later').onclick = () => { bar.hidden = true; };
  $('update-reload').onclick = async () => {
    if (host.hasUnsavedWork && !(await host.confirm('Reload to update?', 'You have changes that haven’t been exported. Reloading now will discard them.', 'Reload anyway'))) return;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}

function setupInstall(): void {
  const button = $('install-button') as HTMLButtonElement;
  let deferred: BeforeInstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => undefined);
    deferred = null;
    button.hidden = true;
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; });
}

/** When installed, PageSmith can be chosen as the app for .pdf files (manifest file_handlers). */
function setupFileLaunch(host: Host): void {
  const queue = (window as unknown as { launchQueue?: { setConsumer(fn: (params: LaunchParams) => void): void } }).launchQueue;
  queue?.setConsumer(async params => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map(handle => handle.getFile()));
    await host.openFiles(files, 'replace');
  });
}
