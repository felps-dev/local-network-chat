//Coordsync server commands

import {
  get_changes,
  get_latest_change,
  insert_change,
} from "../changes_db.js";
import { insert_or_update_index } from "../ids_db.js";
import { insert_local_data, processDataAndWaitFeedback } from "./shared.js";

// Check the service name is valid
// If it is, then the server is valid
export const check_valid_server = (self, socket, name, instance_name) => {
  if (name === self.service.name) {
    self.logger("The client is valid");
    socket.emit("valid_server", self.name);
    self.clients.push({ ...socket, name: instance_name });
    set_clients_everyone(self, socket);
  } else {
    self.logger("The client is not valid, disconnecting");
    socket.emit("disconnect");
  }
};

export const set_clients = (self, socket) => {
  socket.emit(
    "set_clients",
    self.clients.map((c) => {
      const host = c.handshake.headers.host.split(":")[0];
      const port = c.handshake.headers.host.split(":")[1];
      return {
        id: c.id,
        connected: c.connected,
        host,
        port,
        name: c.name,
      };
    })
  );
};

export const set_clients_everyone = (self, socket) => {
  socket.broadcast.emit(
    "set_clients",
    self.clients.map((c) => {
      const host = c.handshake.headers.host.split(":")[0];
      const port = c.handshake.headers.host.split(":")[1];
      return {
        id: c.id,
        connected: c.connected,
        host,
        port,
      };
    })
  );
};

export const server_insert_request = async (self, socket, data) => {
  self.logger("Client requested insert");
  self.logger("Data: " + JSON.stringify(data));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === data.identifier
  );
  if (found) {
    const { options } = found;

    const data_to_insert = data.data;
    //Emit to all clients and wait until everyone inserted
    const newExternalId = await processDataAndWaitFeedback(
      self,
      options,
      data.identifier,
      "insert_request",
      data_to_insert,
      socket,
      true,
      (self, client, found, socket) => !found && client.id !== socket.id
    );
    self.logger("All clients inserted");
    //Insert into local database
    await insert_local_data(
      self,
      data.identifier,
      options,
      data_to_insert,
      newExternalId
    );
    await socket.emit("insert_response", {
      identifier: data.identifier,
      externalId: newExternalId,
    });
  }
};

export const server_insert_response = async (self, socket, data) => {
  self.logger("Insert response from client");
  self.logger(JSON.stringify(data));
  const server_queue = self.getQueue(data.identifier, data.externalId);
  const client = self.clients.find((c) => c.id === socket.id);
  await insert_or_update_index(
    self,
    client.name,
    data.identifier,
    data.externalId
  );
  if (server_queue) {
    server_queue.done.push({
      id: socket.id,
    });
  }
};

export const server_update_request = async (self, socket, data) => {
  self.logger("Client requested update");
  self.logger("Data: " + JSON.stringify(data));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === data.identifier
  );
  if (found) {
    const { options } = found;

    const data_to_update = data.data;

    if (!(await options.decideUpdate(data.data))) {
      self.logger("Server decided to not update due to decideUpdate function");
      await socket.emit("update_response", {
        identifier: data.identifier,
        externalId: data.externalId,
      });
      return;
    }

    //Emit to all clients and wait until everyone updated
    await processDataAndWaitFeedback(
      self,
      options,
      data.identifier,
      "update_request",
      data_to_update,
      socket,
      true,
      (self, client, found, socket) => !found && client.id !== socket.id
    );
    self.logger("All clients updated");
    //Update local database
    await options.update(data_to_update);
    await insert_change(self, data.identifier, data.externalId, "update");
    await socket.emit("update_response", {
      identifier: data.identifier,
      externalId: data.externalId,
    });
  }
};

export const server_update_response = (self, socket, data) => {
  self.logger("Update response from client");
  self.logger(JSON.stringify(data));
  const server_queue = self.getQueue(data.identifier, data.externalId);
  if (server_queue) {
    server_queue.done.push({
      id: socket.id,
    });
  }
};

export const server_delete_request = async (self, socket, data) => {
  self.logger("Client requested delete");
  self.logger("Data: " + JSON.stringify(data));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === data.identifier
  );
  if (found) {
    const { options } = found;

    const data_to_delete = data.data;

    if (!options.decideDelete(data.data)) {
      self.logger("Server decided to not delete due to decideDelete function");
      await socket.emit("delete_response", {
        identifier: data.identifier,
        externalId: data.externalId,
      });
      return;
    }

    //Emit to all clients and wait until everyone deleted
    await processDataAndWaitFeedback(
      self,
      options,
      data.identifier,
      "delete_request",
      data_to_delete,
      socket,
      true,
      (self, client, found, socket) => !found && client.id !== socket.id
    );
    self.logger("All clients deleted");
    //Delete from local database
    await options.delete(data_to_delete.externalId);
    await insert_change(self, data.identifier, data.externalId, "delete");
    await socket.emit("delete_response", {
      identifier: data.identifier,
      externalId: data.externalId,
    });
  }
};

export const server_delete_response = (self, socket, data) => {
  self.logger("Delete response from client");
  self.logger(JSON.stringify(data));
  const server_queue = self.getQueue(data.identifier, data.externalId);
  if (server_queue) {
    server_queue.done.push({
      id: socket.id,
    });
  }
};

export const server_set_data = async (
  self,
  socket,
  identifier,
  data,
  changes = [],
  latestExternalId
) => {
  self.logger("Got set data from client");
  self.logger("Data: " + JSON.stringify(data));
  self.logger("Changes: " + JSON.stringify(changes));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === identifier
  );
  if (found) {
    const { options } = found;
    let lowestChangeId = 0;
    let data_to_send = [];

    for (const change of changes) {
      if (!change) continue;
      if (change.type === "delete") {
        await options.delete(change.id);
      }
      if (change.index < lowestChangeId) lowestChangeId = change.index;
      await insert_change(
        self,
        identifier,
        change.id,
        change.type,
        change.index
      );
    }
    const changes_to_send = await get_changes(self, identifier, lowestChangeId);
    let lowestExternalId = latestExternalId;
    if (lowestExternalId == (await options.getLatestExternalId())) {
      lowestExternalId++;
      self.logger("Updating lowest external id to: " + lowestExternalId);
    }
    self.logger("Lowest external id: " + lowestExternalId);
    self.logger("Latest external id: " + (await options.getLatestExternalId()));
    self.logger("Broadcasting data to clients");
    const current_data = await options.getData(lowestExternalId);
    for (const item of data) {
      if (current_data.find((d) => options.isEqual(d, item))) continue;
      const server_record = await options.getData(
        item.externalId,
        item.externalId
      );
      if (server_record.length === 0) {
        await insert_local_data(
          self,
          identifier,
          options,
          item,
          item.externalId
        );
        self.logger("Inserted server record");
        self.logger(JSON.stringify(item));
      } else {
        if (options.isEqual(item, server_record[0])) continue;
        if (changes_to_send.find((c) => c.id === item.externalId)) {
          await options.update(item);
          self.logger("Updated server record");
          self.logger(JSON.stringify(item));
          continue;
        }
        const newExternalId = (await options.getLatestExternalId()) + 1;
        item.externalId = newExternalId;
        await insert_local_data(
          self,
          identifier,
          options,
          item,
          item.externalId
        );
      }
    }
    for (const change of changes_to_send) {
      if (change.type === "delete") continue;
      if (change.id < lowestExternalId) lowestExternalId = change.id;
      self.logger("Found change to send");
      self.logger(JSON.stringify(change));
      self.logger("Lowest external id: " + lowestExternalId);
    }
    //Get lowest external id from data array
    data_to_send = await options.getData(lowestExternalId);
    self.logger("Data: " + JSON.stringify(data_to_send));
    self.logger("Changes: " + JSON.stringify(changes_to_send));
    self.server.emit("set_data", identifier, data_to_send, changes_to_send);
  }
};

export const server_get_data = async (
  self,
  socket,
  identifier,
  lastExternalId,
  latestChange
) => {
  self.logger("Client requested data");
  self.logger("Identifier: " + identifier);
  self.logger("Last external id: " + lastExternalId);
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === identifier
  );
  if (found) {
    const { options } = found;
    if (!options.getData) {
      throw new Error("getData function not defined on " + identifier);
    }
    const data = await options.getData(lastExternalId);
    const changes =
      (latestChange
        ? await get_changes(self, identifier, latestChange)
        : [await get_latest_change(self, identifier)]) || [];
    for (const change of changes) {
      if (change && change.type === "update") {
        const data_to_update = await options.getData(change.id, change.id);
        if (data_to_update.length > 0) {
          data.push(data_to_update[0]);
        }
      }
    }
    self.logger("Sending data to client");
    self.logger("Data: " + JSON.stringify(data));
    socket.emit("set_data", identifier, data, changes);
  }
};
