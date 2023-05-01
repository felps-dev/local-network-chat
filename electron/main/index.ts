import { BrowserWindow, app, ipcMain, shell } from "electron";
import { release } from "node:os";
import { join } from "node:path";
import SyncService from "../coordsync/sync";

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.js    > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.DIST_ELECTRON = join(__dirname, "../");
process.env.DIST = join(process.env.DIST_ELECTRON, "../dist");
process.env.PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, "../public")
  : process.env.DIST;

// Disable GPU Acceleration for Windows 7
if (release().startsWith("6.1")) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

let win: BrowserWindow | null = null;
// Here, you can also use other preload
const preload = join(__dirname, "../preload/index.js");
const url = process.env.VITE_DEV_SERVER_URL;
const indexHtml = join(process.env.DIST, "index.html");

async function createWindow() {
  win = new BrowserWindow({
    title: "Main window",
    icon: join(process.env.PUBLIC, "favicon.ico"),
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (url) {
    // electron-vite-vue#298
    win.loadURL(url);
    // Open devTool if the app is not packaged
    win.webContents.openDevTools();
  } else {
    win.loadFile(indexHtml);
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  win = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

// New window example arg: new windows url
ipcMain.handle("open-win", (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${url}#${arg}`);
  } else {
    childWindow.loadFile(indexHtml, { hash: arg });
  }
});

import Datastore from "@seald-io/nedb";

const chat_database = new Datastore({
  filename: "databases/chat_db_" + process.argv[2] + ".db",
  autoload: true,
});

const syncService = new SyncService(
  "TestServer 1",
  8002,
  8001,
  true,
  "chat_" + process.argv[2]
);

const refreshRendererMessages = () => {
  win?.webContents.send("refresh-messages");
};

syncService.defineSync("test", {
  getLatestExternalId: async () => {
    const latest = await chat_database
      .findOneAsync({ externalId: { $ne: null } })
      .sort({ externalId: -1 });
    if (latest) {
      return latest.externalId;
    }
    return 0;
  },
  isEqual: (data1: any, data2: any) => {
    return data1.message === data2.message;
  },
  getData: async (from: number, to: number) => {
    if (to) {
      return await chat_database.findAsync({
        externalId: { $gte: from, $lte: to },
      });
    }
    return await chat_database.findAsync({ externalId: { $gte: from } });
  },
  afterInsert: async (data: any, externalId: number) => {
    await chat_database.updateAsync(
      { _id: data._id },
      { $set: { externalId } },
      {}
    );
    refreshRendererMessages();
  },
  fetchInsert: async () => {
    return await chat_database.findOneAsync({ externalId: null });
  },
  insert: async (data: any, externalId: number) => {
    await chat_database.insert({
      message: data.message,
      date: typeof data.date === "string" ? Date.parse(data.date) : data.date,
      externalId,
      mustUpdate: false,
      lastUpdate: data.lastUpdate,
      mustDelete: false,
    });
    refreshRendererMessages();
  },
  afterUpdate: async (data: any) => {
    await chat_database.updateAsync(
      { externalId: data.externalId },
      { $set: { mustUpdate: false } },
      {}
    );
    refreshRendererMessages();
  },
  fetchUpdate: async () => {
    return await chat_database.findOneAsync({ mustUpdate: true });
  },
  decideUpdate: async (newData: any) => {
    true;
    // const localData = await chat_database.findOneAsync({
    //   externalId: newData.externalId,
    // });
    // return Date.parse(newData.lastUpdate) > Date.parse(localData.lastUpdate);
  },
  update: async (data: any) => {
    await chat_database.updateAsync(
      { externalId: data.externalId },
      {
        $set: {
          message: data.message,
          date:
            typeof data.date === "string" ? Date.parse(data.date) : data.date,
          mustUpdate: false,
          lastUpdate: data.lastUpdate,
          mustDelete: false,
        },
      },
      {}
    );
    refreshRendererMessages();
  },
  afterDelete: async (data: any) => {
    await chat_database.removeAsync(
      { externalId: Number(data.externalId) },
      {}
    );
    refreshRendererMessages();
  },
  fetchDelete: async () => {
    return await chat_database.findOneAsync({ mustDelete: true });
  },
  decideDelete: () => {
    return true;
  },
  delete: async (externalId: number) => {
    await chat_database.removeAsync({ externalId: Number(externalId) }, {});
    refreshRendererMessages();
  },
});

syncService.start();

ipcMain.handle("get-messages", async () => {
  const messages = await chat_database.findAsync({});
  //order by date
  messages.sort((a, b) => {
    //@ts-expect-error
    return new Date(a.date) - new Date(b.date);
  });
  return messages;
});

ipcMain.handle("send-message", async (_, message: string) => {
  await chat_database.insertAsync({
    message,
    date: Date.now(),
    externalId: null,
    mustUpdate: false,
    lastUpdate: null,
    mustDelete: false,
  });
});

ipcMain.handle("delete-message", async (_, externalId: number) => {
  await chat_database.updateAsync(
    { externalId },
    { $set: { mustDelete: true } },
    {}
  );
  return true;
});

ipcMain.handle(
  "update-message",
  async (_, externalId: number, message: string) => {
    await chat_database.updateAsync(
      { externalId },
      { $set: { mustUpdate: true, message, lastUpdate: new Date() } },
      {}
    );
    return true;
  }
);
