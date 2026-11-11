const { app } = require('electron');
app.whenReady().then(async () => {
  try {
    await require('../tests/database.cjs').run();
    await require('../tests/face-service.cjs').run();
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
