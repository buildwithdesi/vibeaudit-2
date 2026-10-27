// Stand-in database client so the seeded routes parse and read naturally.
export const db = {
  async query(sql) {
    return [{ sql }];
  },
};
