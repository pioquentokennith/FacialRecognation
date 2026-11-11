const { app, BrowserWindow, ipcMain, protocol, net, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Store, exportCSV } = require('./database.cjs');
const { VisionBackend } = require('./vision-backend.cjs');
const { FaceService } = require('./face-service.cjs');

const development = !app.isPackaged && process.argv.includes('--dev');
const smoke = process.argv.includes('--smoke-test');
const testMode = process.env.PRESENCE_TEST === '1' && !app.isPackaged;
if ((smoke || testMode) && process.env.PRESENCE_DATA_DIR) app.setPath('userData', process.env.PRESENCE_DATA_DIR);
if (smoke && !process.env.PRESENCE_DATA_DIR) app.setPath('userData', path.join(app.getPath('temp'), 'presence-smoke-' + process.pid));
protocol.registerSchemesAsPrivileged([{ scheme: 'presence', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let store;
let window;
let maintenance = false;
let backend;
let faces;

function trusted(url) {
  try {
    const parsed = new URL(url);
    return development ? parsed.origin === 'http://127.0.0.1:5173' : parsed.protocol === 'presence:' && parsed.hostname === 'app';
  } catch { return false; }
}
function registerIPC() {
  const handlers = Object.fromEntries([
    'changePassword', 'students', 'saveStudent', 'archiveStudent', 'deleteStudent', 'deleteFace',
    'faceStatus', 'includeStudentsToday', 'days', 'day', 'openDay', 'closeDay', 'reopenDay', 'correctAttendance', 'records',
    'dashboard', 'users', 'saveUser', 'resetPassword', 'audit',
  ].map(action => [action, payload => store[action](payload)]));
  handlers.login = payload => { const user = store.login(payload); faces.reset(); return user; };
  handlers.logout = () => { const result = store.logout(); faces.reset(); return result; };
  handlers.visionHealth = () => faces.health();
  handlers.beginFaceScan = payload => faces.begin(payload);
  handlers.processFaceFrame = payload => faces.frame(payload);
  handlers.cancelFaceScan = payload => faces.cancel(payload);
  handlers.saveFaceEnrollment = payload => faces.saveEnrollment(payload);
  handlers.recordAttendance = payload => faces.recordAttendance(payload);
  handlers.session = () => store.current();
  handlers.info = () => { store.require(); return { version: app.getVersion(), database: store.filename, platform: process.platform, today: store.today() }; };
  handlers.exportCSV = async payload => {
    const rows = store.records(payload);
    const result = await dialog.showSaveDialog(window, { title: 'Export attendance report', defaultPath: `attendance-${store.today()}.csv`, filters: [{ name: 'CSV report', extensions: ['csv'] }] });
    if (result.canceled) return { canceled: true };
    store.require();
    if (path.extname(result.filePath).toLowerCase() !== '.csv' || path.resolve(result.filePath).toLowerCase().startsWith(path.resolve(store.filename).toLowerCase())) throw new Error('Choose a CSV report filename outside the live database files.');
    await fs.promises.writeFile(result.filePath, exportCSV(rows), 'utf8');
    return { path: result.filePath, count: rows.length };
  };
  handlers.backup = async () => {
    store.require(true);
    const result = await dialog.showSaveDialog(window, { title: 'Save complete local backup', defaultPath: `presence-backup-${store.today()}.sqlite`, filters: [{ name: 'Presence database', extensions: ['sqlite'] }] });
    if (result.canceled) return { canceled: true };
    store.require(true);
    maintenance = true;
    try { await store.backup(result.filePath); return { path: result.filePath }; } finally { maintenance = false; }
  };
  handlers.restore = async () => {
    store.require(true);
    const selected = await dialog.showOpenDialog(window, { title: 'Restore a Presence backup', properties: ['openFile'], filters: [{ name: 'Presence database', extensions: ['sqlite'] }] });
    if (selected.canceled) return { canceled: true };
    store.require(true);
    Store.validateBackup(selected.filePaths[0]);
    const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Restore backup?', message: 'Replace this application’s data with the selected backup?', detail: 'A recovery copy of your current database will be saved first. You will be logged out. Use the accounts and passwords from the restored backup.', buttons: ['Cancel', 'Restore backup'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return { canceled: true };
    store.require(true);
    maintenance = true;
    faces.reset();
    try { return await store.restore(selected.filePaths[0]); } finally { maintenance = false; }
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`presence:${name}`, async (event, payload) => {
      try {
        if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Untrusted application request.');
        if (maintenance) throw new Error('A backup or restore is in progress. Please wait.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request.');
        return { ok: true, data: await handler(payload) };
      } catch (error) {
        console.error(`[${name}]`, error.message);
        return { ok: false, error: error.code?.startsWith('SQLITE') ? 'The database operation could not be completed. Please retry or restore a working backup.' : error.message };
      }
    });
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      const dist = path.resolve(__dirname, '../dist');
      protocol.handle('presence', request => {
        const url = new URL(request.url);
        if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
        const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (target !== dist && !target.startsWith(dist + path.sep)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(target).href);
      });
      store = new Store(path.join(app.getPath('userData'), 'presence.sqlite'));
      backend = new VisionBackend(app.isPackaged ? path.join(process.resourcesPath, 'vision-backend') : path.resolve(__dirname, '../backend'));
      faces = new FaceService(store, backend);
      backend.start().catch(error => console.error('Offline face engine:', error.message));
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        callback(contents === window?.webContents && trusted(details.requestingUrl || contents.getURL()) && permission === 'media'
          && (!details.mediaTypes || details.mediaTypes.every(type => type === 'video')));
      });
      session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => contents === window?.webContents
        && trusted(origin || details.requestingUrl || '') && permission === 'media' && details.mediaType !== 'audio');
      registerIPC();
      window = new BrowserWindow({ width: 1360, height: 900, minWidth: 1000, minHeight: 700, show: false,
        backgroundColor: '#f5f6f8', title: 'Presence Attendance', icon: path.join(dist, 'icon.png'), autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.on('close', event => { if (maintenance) event.preventDefault(); });
      window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.once('ready-to-show', () => { if (!smoke) window.show(); });
      await window.loadURL(development ? 'http://127.0.0.1:5173' : 'presence://app/index.html');
      if (smoke) {
        const result = await window.webContents.executeJavaScript(`(async () => {
          const login = await window.desktop.login({username:'admin',password:'admin123'});
          const info = await window.desktop.info();
          const vision = await window.desktop.visionHealth();
          return {title:document.title,login:login.ok,database:info.ok,models:vision.ok && vision.data.ready,offlineBackend:vision.ok && vision.data.offline,secure:window.isSecureContext,ui:!!document.querySelector('#root')?.textContent};
        })()`);
        console.log('PRESENCE_SMOKE_RESULT', JSON.stringify(result));
        if (!Object.values(result).every(Boolean)) throw new Error('Smoke test failed.');
        backend.stop();
        app.exit(0);
      }
    } catch (error) {
      console.error(error);
      if (!smoke && !testMode) dialog.showErrorBox('Presence could not start', `${error.message}\n\nYour existing data has not been reset.`);
      app.exit(1);
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (maintenance) { event.preventDefault(); return; } faces?.reset(); backend?.stop(); store?.close(); });
}
