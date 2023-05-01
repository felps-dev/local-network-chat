import {
  get_changes,
  get_latest_change,
  insert_change,
} from "../changes_db.js";
import {
  get_latest_change_index,
  get_latest_index,
  insert_or_update_index,
} from "../ids_db.js";
import { insert_local_data } from "./shared.js";

export const client_set_clients = async (self, socket, clients) => {
  self.logger("Got clients from server");
  self.logger("Clients: " + JSON.stringify(clients));
  self.clients = clients;
  for (const dataSync of self.dataToSync) {
    const latest_known_server_id = await get_latest_index(
      self,
      self.current_server.name,
      dataSync.identifier
    );
    const latest_known_server_change_id = await get_latest_change_index(
      self,
      self.current_server.name,
      dataSync.identifier
    );
    const latest_local_id = await dataSync.options.getLatestExternalId();
    self.logger("Latest known server id: " + latest_known_server_id);
    self.logger("Latest local id: " + latest_local_id);
    if (latest_known_server_id <= latest_local_id && latest_local_id > 0) {
      self.logger("Server is behind, inserting data");
      client_get_data(
        self,
        socket,
        dataSync.identifier,
        latest_known_server_id,
        latest_known_server_change_id
      );
      return true;
    }
    self.logger("Latest change: " + latest_known_server_change_id);
    self.logger("Sending get_data request to server");
    self.logger("Identifier: " + dataSync.identifier);
    self.client.emit(
      "get_data",
      dataSync.identifier,
      latest_known_server_id,
      latest_known_server_change_id
    );
  }
};

export const client_server_validated = async (self, socket, server_name) => {
  self.logger("Server said it was valid");
  self.current_server = {
    name: server_name,
  };
  socket.emit("get_clients");
  self.client_id = socket.id;
};

export const client_insert_request = (self, socket, data) => {
  self.logger("Got insert request from server");
  self.logger("Data: " + JSON.stringify(data));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === data.identifier
  );
  if (found) {
    const { options } = found;
    insert_local_data(
      self,
      data.identifier,
      options,
      data.data,
      data.externalId
    );
    socket.emit("insert_response", {
      identifier: data.identifier,
      externalId: data.externalId,
    });
  }
};

export const client_insert_response = (self, socket, data) => {
  self.logger("Got insert response from server");
  self.logger("Data: " + JSON.stringify(data));
  const queue = self.getQueue(data.identifier);
  self.logger("Queue: " + JSON.stringify(queue));
  if (queue) {
    queue.done.push({
      id: socket.id,
      externalId: data.externalId,
    });
  }
};

export const client_update_request = async (self, socket, data) => {
  self.logger("Got update request from server");
  self.logger("Data: " + JSON.stringify(data));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === data.identifier
  );
  if (found) {
    const { options } = found;
    if (await options.decideUpdate(data.data)) {
      options.update(data.data);
      insert_change(self, data.identifier, data.externalId, "update");
    }
    socket.emit("update_response", {
      identifier: data.identifier,
      externalId: data.externalId,
    });
  }
};

export const client_update_response = (self, socket, data) => {
  self.logger("Got update response from server");
  self.logger("Data: " + JSON.stringify(data));
  const queue = self.getQueue(data.identifier, data.externalId);
  if (queue) {
    queue.done.push({
      id: socket.id,
      externalId: data.externalId,
    });
  }
};

export const client_delete_request = (self, socket, data) => {
  self.logger("Got delete request from server");
  self.logger("Data: " + JSON.stringify(data));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === data.identifier
  );
  if (found) {
    const { options } = found;
    options.delete(data.data.externalId);
    insert_change(self, data.identifier, data.externalId, "delete");
    socket.emit("delete_response", {
      identifier: data.identifier,
      externalId: data.externalId,
    });
  }
};

export const client_delete_response = (self, socket, data) => {
  self.logger("Got delete response from server");
  self.logger("Data: " + JSON.stringify(data));
  const queue = self.getQueue(data.identifier, data.externalId);
  if (queue) {
    queue.done.push({
      id: socket.id,
      externalId: data.externalId,
    });
  }
};

export const client_set_data = async (
  self,
  socket,
  identifier,
  data,
  changes = []
) => {
  self.logger("Got set data from server");
  self.logger("Data: " + JSON.stringify(data));
  self.logger("Changes: " + JSON.stringify(changes));
  const found = self.dataToSync.find(
    (dataSync) => dataSync.identifier === identifier
  );
  if (found) {
    const { options } = found;
    for (const change of changes) {
      if (!change) continue;
      if (change.type === "delete") {
        await options.delete(change.id);
      }
      insert_change(self, identifier, change.id, change.type, change.index);
    }
    for (const item of data) {
      const local_data = await options.getData(
        item.externalId,
        item.externalId
      );
      if (local_data.length === 0) {
        await insert_local_data(
          self,
          identifier,
          options,
          item,
          item.externalId
        );
      } else {
        await options.update(item);
      }
    }
    const latest_id = await options.getLatestExternalId();
    await insert_or_update_index(
      self,
      self.current_server.name,
      identifier,
      latest_id
    );
    socket.emit("insert_response", {
      identifier: identifier,
      externalId: latest_id,
    });
  }
};

export const client_get_data = async (
  self,
  socket,
  identifier,
  lastExternalId,
  latestChange
) => {
  self.logger("Server requested data");
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
    const data = await options.getData(Number(lastExternalId) + 1);
    const changes =
      (latestChange
        ? await get_changes(self, identifier, latestChange)
        : [await get_latest_change(self, identifier)]) || [];
    for (const change of changes) {
      if (change && change.type === "update") {
        const data_to_update = await options.getData(change.id, change.id);
        if (data_to_update.length > 0) {
          if (data.find((d) => d.externalId === change.id)) continue;
          data.push(data_to_update[0]);
        }
      }
    }
    self.logger("Sending data to server");
    self.logger("Data: " + JSON.stringify(data));
    socket.emit("set_data", identifier, data, changes, lastExternalId);
  }
};
