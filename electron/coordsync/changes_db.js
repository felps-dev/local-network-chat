import { insert_or_update_index } from "./ids_db.js";

export const insert_change = async (self, identifier, id, type, index) => {
  const db = self.changes_db;
  const last_index =
    (await db.findOneAsync({ identifier }).sort({ index: -1 }))?.index || 0;
  const latest_change_index = index || last_index + 1;
  await db.insert({ index: latest_change_index, identifier, id, type });
  insert_or_update_index(
    self,
    self.current_server.name,
    identifier,
    undefined,
    latest_change_index
  );
  return latest_change_index;
};

export const get_changes = async (self, identifier, from) => {
  const change_list = await self.changes_db.findAsync({
    index: { $gt: from },
    identifier,
  });
  // Remove duplicated changes, using ID and getting the latest one
  const changes = {};
  for (const change of change_list) {
    changes[change.id] = change;
  }
  return Object.values(changes);
};

export const get_latest_change = async (self, identifier) => {
  const db = self.changes_db;
  return await db.findOneAsync({ identifier }).sort({ index: -1 });
};
