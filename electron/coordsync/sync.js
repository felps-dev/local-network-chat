import Diont from "diont";
import { Server as ioServer } from "socket.io";
import { io } from "socket.io-client";
import { insert_change } from "./changes_db.js";
import {
  client_delete_request,
  client_delete_response,
  client_get_data,
  client_insert_request,
  client_insert_response,
  client_server_validated,
  client_set_clients,
  client_set_data,
  client_update_request,
  client_update_response,
} from "./commands/client.js";
import {
  check_valid_server,
  server_delete_request,
  server_delete_response,
  server_get_data,
  server_insert_request,
  server_insert_response,
  server_set_data,
  server_update_request,
  server_update_response,
  set_clients,
  set_clients_everyone,
} from "./commands/server.js";
import { open_db, processDataAndWaitFeedback } from "./commands/shared.js";
import {
  PROCESSING_INTERVAL,
  RESTART_ON_ERROR_INTERVAL,
  SERVICE_DISCOVERY_TIMEOUT,
} from "./constants.js";
import { insert_or_update_index } from "./ids_db.js";
import { sleep } from "./utils.js";

function simple_log(message, title) {
  console.log(`[${title || "No Title"}] ${message}`);
}

class SyncService {
  constructor(
    serviceName,
    servicePort,
    syncPort,
    log_enabled = true,
    instance_name = "default"
  ) {
    this.diont = Diont.default();
    this.service = {
      name: serviceName,
      port: servicePort,
    };
    this.syncService = {
      port: syncPort,
    };
    this.name = instance_name;
    this.current_server = null;
    this.serviceFound = false;
    this.serviceOnline = false;
    this.isSyncing = false;
    this.syncInterval = null;
    this.server = null;
    this.client = null;
    this.client_id = null;
    this.clients = [];
    this.dataToSync = [];
    this.current_queue = [
      { id: null, identifier: null, externalId: null, done: [] },
    ];
    this.logger = (message, title) =>
      log_enabled ? simple_log(message, title) : null;
    this.log_enabled = log_enabled;
    this.changes_db = open_db(`change_${instance_name}`);
    this.index_db = open_db(`index_${instance_name}`);
  }

  defineSync(identifier, options) {
    this.dataToSync.push({
      identifier,
      options,
    });
  }

  getQueue(identifier, externalId) {
    let queue = this.current_queue.filter((q) => q.identifier === identifier);
    if (externalId) {
      queue = queue.filter((q) => q.externalId === externalId);
    }
    if (queue.length === 0) {
      return null;
    }
    return queue[0];
  }

  async syncInserts(dataSync) {
    const { identifier, options } = dataSync;
    if (!options.fetchInsert) {
      throw new Error("No fetchInsert function defined on " + identifier);
    }
    if (!options.afterInsert) {
      throw new Error("No afterInsert function defined on " + identifier);
    }
    if (!options.getLatestExternalId) {
      throw new Error(
        "No getLatestExternalId function defined on " + identifier
      );
    }
    if (!options.insert) {
      throw new Error("No insert function defined on " + identifier);
    }
    const data_to_insert = await options.fetchInsert();
    if (!data_to_insert) {
      return;
    }
    const isServer = this.server && this.serviceOnline;
    this.logger("Inserting data");
    this.logger(JSON.stringify(data_to_insert));
    const socket = isServer ? this.server : this.client;
    const newExternalId = await processDataAndWaitFeedback(
      this,
      options,
      identifier,
      "insert_request",
      data_to_insert,
      socket
    );
    this.logger(JSON.stringify(this.current_queue));
    options.afterInsert(data_to_insert, newExternalId);
    insert_or_update_index(
      this,
      this.current_server.name,
      identifier,
      newExternalId
    );
  }

  async syncUpdates(dataSync) {
    const { identifier, options } = dataSync;
    if (!options.fetchUpdate) {
      throw new Error("No fetchUpdate function defined on " + identifier);
    }
    if (!options.update) {
      throw new Error("No update function defined on " + identifier);
    }
    const data_to_update = await options.fetchUpdate();
    if (!data_to_update) {
      return;
    }
    this.logger("Updating data");
    this.logger(JSON.stringify(data_to_update));
    const isServer = this.server && this.serviceOnline;
    const socket = isServer ? this.server : this.client;
    await processDataAndWaitFeedback(
      this,
      options,
      identifier,
      "update_request",
      data_to_update,
      socket
    );
    this.logger(JSON.stringify(this.current_queue));
    options.afterUpdate(data_to_update);
    await insert_change(this, identifier, data_to_update.externalId, "update");
  }

  async syncDeletes(dataSync) {
    const { identifier, options } = dataSync;
    if (!options.fetchDelete) {
      throw new Error("No fetchDelete function defined on " + identifier);
    }
    if (!options.delete) {
      throw new Error("No delete function defined on " + identifier);
    }
    const data_to_delete = await options.fetchDelete();
    if (!data_to_delete) {
      return;
    }
    this.logger("Deleting data");
    this.logger(JSON.stringify(data_to_delete));
    const isServer = this.server && this.serviceOnline;
    const socket = isServer ? this.server : this.client;
    await processDataAndWaitFeedback(
      this,
      options,
      identifier,
      "delete_request",
      data_to_delete,
      socket
    );
    this.logger(JSON.stringify(this.current_queue));
    options.afterDelete(data_to_delete);
    await insert_change(this, identifier, data_to_delete.externalId, "delete");
  }

  startSyncing() {
    this.syncInterval = setInterval(async () => {
      if (
        ((this.serviceFound && this.client?.connected) ||
          (this.server && this.serviceOnline)) &&
        !this.isSyncing
      ) {
        //Ready to sync
        this.isSyncing = true;
        for (let index = 0; index < this.dataToSync.length; index++) {
          const dataSync = this.dataToSync[index];
          await this.syncInserts(dataSync);
          await this.syncUpdates(dataSync);
          await this.syncDeletes(dataSync);
        }
        this.isSyncing = false;
      }
    }, 200);
  }

  listenForServices() {
    this.diont.on("serviceAnnounced", (serviceInfo) => {
      if (serviceInfo.service.name === this.service.name) {
        this.serviceFound = true;
        this.logger(
          "Connecting to client: " +
            serviceInfo.service.host +
            ":" +
            this.syncService.port
        );
        this.connectClient(serviceInfo.service.host, this.syncService.port);
      }
    });
  }

  defineClientCommands(client) {
    // Server said that this is a valid client
    client.on("valid_server", (server_name) =>
      client_server_validated(this, client, server_name)
    );
    // Server wants to update client list
    client.on("set_clients", (clients) =>
      client_set_clients(this, client, clients)
    );
    // Server wants to insert data
    client.on("insert_request", (data) =>
      client_insert_request(this, client, data)
    );
    // Server inserted data on all clients and is waiting for response
    client.on("insert_response", (data) =>
      client_insert_response(this, client, data)
    );
    // Server wants to update data
    client.on("update_request", (data) =>
      client_update_request(this, client, data)
    );
    // Server updated data on all clients and is waiting for response
    client.on("update_response", (data) =>
      client_update_response(this, client, data)
    );
    // Server wants to delete data
    client.on("delete_request", (data) =>
      client_delete_request(this, client, data)
    );
    // Server deleted data on all clients and is waiting for response
    client.on("delete_response", (data) =>
      client_delete_response(this, client, data)
    );
    // Server wants to update data
    client.on("set_data", async (identifier, data, changes) =>
      client_set_data(this, client, identifier, data, changes)
    );
    // Server asked for updated data
    client.on("get_data", async (identifier, externalId, latestChange) =>
      client_get_data(this, client, identifier, externalId, latestChange)
    );
    // Server disconnected, try to connect to next client(Assuming next client is the server)
    client.on("disconnect", async () => {
      this.logger("Disconnected from server");

      if (await this.connectNextClient()) {
        return;
      }

      this.stop();
      this.start();
    });
  }

  async connectNextClient() {
    await sleep(PROCESSING_INTERVAL);
    this.logger("Client count: " + this.clients.length);
    if (this.clients.length > 0) {
      if (this.clients[0].id === this.client_id) {
        this.logger("First client is this client");
        return false;
      }
      let successFullConnection = false;
      let tries = 0;
      while (!successFullConnection) {
        const next = this.clients.shift();
        this.logger("Next client: " + JSON.stringify(next));
        if (next && next.id !== this.client_id) {
          while (!this.client?.connected && tries < 20) {
            this.logger("Connecting to next client, tries: " + tries);
            this.connectClient(next.host, next.port);
            await sleep(5000);
            if (!this.client.connected) {
              this.logger("Client failed to connect");
              tries += 1;
            } else {
              successFullConnection = true;
              this.logger("Client connected");
            }
            await sleep(2000);
          }
        }
      }
      return successFullConnection;
    }
    return false;
  }

  connectClient(host, port) {
    this.client = io(`http://${host}:${port}`, {
      reconnection: false,
      timeout: 3000,
    });

    this.client.on("connect", async () => {
      this.logger("Connected as client");
      this.client.emit("check_valid_server", this.service.name, this.name);
    });

    this.defineClientCommands(this.client);
    this.client.connect();
  }

  startService() {
    setTimeout(async () => {
      if (!this.serviceFound) {
        this.logger("No service found");
        this.logger("Starting service");
        this.diont.announceService(this.service);
        await this.startServer();
      }
    }, SERVICE_DISCOVERY_TIMEOUT);
  }

  defineServerCommands(server) {
    // When clients connect, we check if they are valid
    server.on("check_valid_server", (name, instance_name) =>
      check_valid_server(this, server, name, instance_name)
    );
    // Clients can request the list of clients
    server.on("get_clients", () => set_clients(this, server));
    // Clients can request a insert, that will be synced to all other clients, and after on server
    server.on("insert_request", (data) =>
      server_insert_request(this, server, data)
    );
    // When client has inserted data, it will send a response to the server that it has done so
    server.on("insert_response", (data) =>
      server_insert_response(this, server, data)
    );
    // Clients can request a update, that will be synced to all other clients, and after on server
    server.on("update_request", (data) =>
      server_update_request(this, server, data)
    );
    // When client has updated data, it will send a response to the server that it has done so
    server.on("update_response", (data) =>
      server_update_response(this, server, data)
    );
    // Clients can request a delete, that will be synced to all other clients, and after on server
    server.on("delete_request", (data) =>
      server_delete_request(this, server, data)
    );
    // When client has deleted data, it will send a response to the server that it has done so
    server.on("delete_response", (data) =>
      server_delete_response(this, server, data)
    );
    // Clients can request data from the server
    server.on("get_data", (identifier, externalId, latestChange) => {
      server_get_data(this, server, identifier, externalId, latestChange);
    });
    // Clients can set data on the server
    server.on("set_data", (identifier, data, changes, latestExternalId) =>
      server_set_data(this, server, identifier, data, changes, latestExternalId)
    );
    // When a client disconnects, we remove it from the list of clients
    // And send the new list to all clients
    server.on("disconnect", () => {
      this.logger("Client disconnected");
      this.clients = this.clients.filter((c) => c.id !== server.id);
      set_clients_everyone(this, server);
    });
  }

  async startServer() {
    this.server = new ioServer();
    this.current_server = {
      name: this.name,
    };
    // After a client connects, we add it to the list of clients
    // And send the new list to all clients
    this.server.on("connection", (socket) => {
      this.logger("Someone connected to server");
      this.defineServerCommands(socket);
    });
    // If the server fails to start, we try again in 2 seconds
    // This is to prevent the server from crashing
    this.server.on("error", async (e) => {
      this.logger(
        `Error starting service. Trying again in ${
          RESTART_ON_ERROR_INTERVAL / 1000
        } seconds`
      );
      this.logger(e);
      await sleep(RESTART_ON_ERROR_INTERVAL);
      this.stop();
      this.start();
    });
    this.server.listen(this.syncService.port);
    this.serviceOnline = true;
  }

  start() {
    // Start the service
    this.logger("Starting");
    this.listenForServices();
    this.startService();
    this.startSyncing();
  }

  becomeClient() {
    // Become a client
    this.logger("Becoming client");
    this.stop();
    this.listenForServices();
  }

  stop() {
    // Stop the service and clear all variables
    if (this.server) {
      this.server.close();
      this.server.httpServer.close();
    }
    if (this.client) {
      this.client.disconnect();
    }
    this.client = null;
    this.server = null;
    this.clients = [];
    this.serviceFound = false;
    this.serviceOnline = false;
    this.isSyncing = false;
    this.syncInterval = null;
    this.current_server = null;
    this.current_queue = [];
    clearInterval(this.syncInterval);
    this.logger("Stopped");
  }
}

export default SyncService;
