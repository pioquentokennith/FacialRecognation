const { contextBridge, ipcRenderer } = require('electron');

const actions = [
  'session', 'login', 'logout', 'changePassword', 'students', 'saveStudent', 'archiveStudent',
  'deleteStudent', 'deleteFace', 'faceStatus', 'includeStudentsToday', 'visionHealth', 'beginFaceScan', 'processFaceFrame', 'cancelFaceScan', 'saveFaceEnrollment', 'days', 'day', 'openDay',
  'closeDay', 'reopenDay', 'recordAttendance', 'correctAttendance', 'records', 'dashboard',
  'users', 'saveUser', 'resetPassword', 'audit', 'info', 'exportCSV', 'backup', 'restore',
];
contextBridge.exposeInMainWorld('desktop', Object.fromEntries(
  actions.map(action => [action, (payload = {}) => ipcRenderer.invoke(`presence:${action}`, payload)]),
));
