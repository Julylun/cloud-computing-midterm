export const SESSION_SECRET = '9f4b73f8c65d8cf597def665e6fa2c2b4a912a73eeb7dc56f1c418ac3dc10e9a';

const clone = (value) => structuredClone(value);

function authorizationError() {
  return Object.assign(new Error('Collection operation is not permitted for this role.'), { code: 13 });
}

function matches(document, filter) {
  if (!document || (filter._id !== undefined && document._id !== filter._id)) return false;
  if (filter.expiresAt?.$gt && !(document.expiresAt > filter.expiresAt.$gt)) return false;
  return true;
}

async function failIfConfigured(fault) {
  if (typeof fault === 'function') await fault();
  else if (fault) throw fault;
}

// The fake implements MongoDB operations, not an express-session MemoryStore.
// JSON/BSON copies on each read prevent a test from passing through shared references.
export function createSessionDatabase() {
  const documents = new Map();
  const books = [];
  const calls = [];
  const faults = { readSession: null, writeSession: null, listBooks: null, insertBook: null };

  function collection(role, name) {
    if (name !== 'sessions') throw new Error('Unexpected collection: ' + name);
    return {
      async findOne(filter) {
        calls.push({ role, operation: 'findOne', filter: clone(filter) });
        if (role !== 'read') throw authorizationError();
        await failIfConfigured(faults.readSession);
        const document = documents.get(filter._id);
        return matches(document, filter) ? clone(document) : null;
      },
      async updateOne(filter, update, options = {}) {
        calls.push({ role, operation: 'updateOne', filter: clone(filter), update: clone(update), options: clone(options) });
        if (role !== 'write') throw authorizationError();
        await failIfConfigured(faults.writeSession);
        const current = documents.get(filter._id);
        const found = matches(current, filter);
        if (!found && !options.upsert) {
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
        }
        const document = found ? clone(current) : { _id: filter._id, ...clone(update.$setOnInsert || {}) };
        Object.assign(document, clone(update.$set || {}));
        for (const key of Object.keys(update.$unset || {})) delete document[key];
        documents.set(filter._id, document);
        return {
          acknowledged: true,
          matchedCount: found ? 1 : 0,
          modifiedCount: found ? 1 : 0,
          upsertedCount: found ? 0 : 1,
          upsertedId: found ? null : filter._id,
        };
      },
      async deleteOne(filter) {
        calls.push({ role, operation: 'deleteOne', filter: clone(filter) });
        if (role !== 'write') throw authorizationError();
        await failIfConfigured(faults.writeSession);
        const found = matches(documents.get(filter._id), filter);
        if (found) documents.delete(filter._id);
        return { acknowledged: true, deletedCount: found ? 1 : 0 };
      },
    };
  }

  const database = {
    readDb: { collection: (name) => collection('read', name) },
    writeDb: { collection: (name) => collection('write', name) },
    books: {
      async list() {
        await failIfConfigured(faults.listBooks);
        return clone(books);
      },
      async insert(book) {
        await failIfConfigured(faults.insertBook);
        books.push(clone(book));
        return { acknowledged: true, insertedId: String(books.length) };
      },
    },
    async health() {},
  };
  return { database, documents, books, calls, faults };
}
