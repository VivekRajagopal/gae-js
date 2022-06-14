import { Datastore, Key } from "@google-cloud/datastore";
import { DatastoreRepository } from "./datastore-repository";
import { connectDatastoreEmulator, deleteKind } from "./test-utils";
import { runInTransaction } from "./transactional";
import {
  IndexConfig,
  IndexEntry,
  iots as t,
  iotsValidator,
  Page,
  runWithRequestStorage,
  SearchFields,
  SearchService,
  Sort,
} from "@mondomob/gae-js-core";
import { datastoreLoaderRequestStorage } from "./datastore-request-storage";
import { DatastoreLoader } from "./datastore-loader";
import { datastoreProvider } from "./datastore-provider";

const repositoryItemSchema = t.intersection([
  t.type({
    id: t.string,
    name: t.string,
  }),
  t.partial({
    prop1: t.string,
    prop2: t.string,
    prop3: t.string,
    nested: t.type({
      prop4: t.string,
    }),
    propArray: t.array(t.string),
  }),
]);

type RepositoryItem = t.TypeOf<typeof repositoryItemSchema>;

const validator = iotsValidator(repositoryItemSchema);

// TODO: beforePersist hook
// TODO: upsert

describe("DatastoreRepository", () => {
  const collection = "repository-items";
  let datastore: Datastore;
  let repository: DatastoreRepository<RepositoryItem>;

  beforeAll(async () => (datastore = connectDatastoreEmulator()));
  beforeEach(async () => {
    await deleteKind(datastore, collection);
    repository = new DatastoreRepository<RepositoryItem>(collection, { datastore });
    jest.clearAllMocks();
  });

  const itemKey = (id: string): Key => datastore.key([collection, id]);

  const createItem = (id: string, data?: Record<string, unknown>) => {
    return {
      id,
      name: `Test Item ${id}`,
      ...data,
    };
  };

  const insertItem = async (id: string) => {
    return datastore.insert({
      key: itemKey(id),
      data: {
        name: `test${id}`,
      },
    });
  };

  describe("exists", () => {
    it("returns true when a document exists", async () => {
      await insertItem("123");
      expect(await repository.exists("123")).toBe(true);
    });

    it("returns false when a document does not exist", async () => {
      expect(await repository.exists("does-not-exist-123")).toBe(false);
    });
  });

  describe("get", () => {
    it("fetches document that exists", async () => {
      await insertItem("123");

      const document = await repository.get("123");

      expect(document).toEqual({
        id: "123",
        name: "test123",
      });
    });

    it("returns null for document that doesn't exist", async () => {
      const document = await repository.get("123");

      expect(document).toBe(null);
    });

    describe("with schema", () => {
      beforeEach(() => {
        repository = new DatastoreRepository<RepositoryItem>(collection, {
          datastore,
          validator,
        });
      });

      it("fetches document that exists and matches schema", async () => {
        await insertItem("123");

        const document = await repository.get("123");

        expect(document).toEqual({
          id: "123",
          name: "test123",
        });
      });

      it("throws for document that doesn't match schema", async () => {
        await datastore.insert({
          key: itemKey("123"),
          data: {
            description: "test123",
          },
        });
        await expect(repository.get("123")).rejects.toThrow('"repository-items" with id "123" failed to load');
      });
    });

    describe("with datastore client in provider", () => {
      beforeEach(() => {
        datastoreProvider.set(datastore);
        repository = new DatastoreRepository<RepositoryItem>(collection, { validator });
      });

      it("fetches document that exists and matches schema", async () => {
        await insertItem("123");

        const document = await repository.get("123");

        expect(document).toEqual({
          id: "123",
          name: "test123",
        });
      });
    });
  });

  describe("getRequired", () => {
    it("fetches document that exists", async () => {
      await insertItem("123");

      const document = await repository.getRequired("123");

      expect(document).toEqual({
        id: "123",
        name: "test123",
      });
    });

    it("throws for document that doesn't exist", async () => {
      await expect(repository.getRequired("123")).rejects.toThrow("invalid id");
    });

    describe("with array", () => {
      it("fetches documents that exist", async () => {
        await insertItem("123");
        await insertItem("234");

        const results = await repository.getRequired(["123", "234"]);

        expect(results).toEqual([
          {
            id: "123",
            name: "test123",
          },
          {
            id: "234",
            name: "test234",
          },
        ]);
      });

      it("throws for any document that doesn't exist", async () => {
        await insertItem("123");

        await expect(repository.getRequired(["123", "does-not-exist", "also-does-not-exist"])).rejects.toThrow(
          '"repository-items" with id "does-not-exist" failed to load'
        );
      });
    });

    describe("with schema", () => {
      beforeEach(() => {
        repository = new DatastoreRepository<RepositoryItem>(collection, {
          datastore,
          validator,
        });
      });

      it("fetches document that exists and matches schema", async () => {
        await insertItem("123");

        const document = await repository.getRequired("123");

        expect(document).toEqual({
          id: "123",
          name: "test123",
        });
      });

      it("throws for document that doesn't match schema", async () => {
        await datastore.insert({
          key: itemKey("123"),
          data: {
            description: "test123",
          },
        });
        await expect(repository.getRequired("123")).rejects.toThrow('"repository-items" with id "123" failed to load');
      });
    });
  });

  describe("save", () => {
    it("saves documents outside of transaction", async () => {
      await repository.save([createItem("123"), createItem("234")]);

      const fetched = await repository.get(["123", "234"]);
      expect(fetched.length).toBe(2);
      expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123` });
    });

    it("saves documents in transaction", async () => {
      await runWithRequestStorage(async () => {
        datastoreLoaderRequestStorage.set(new DatastoreLoader(datastore));
        return runInTransaction(() => repository.save([createItem("123"), createItem("234")]));
      });

      const fetched = await repository.get(["123", "234"]);
      expect(fetched.length).toBe(2);
      expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123` });
    });

    it("overwrites document that already exists", async () => {
      await repository.save(createItem("123", { message: "create" }));
      await repository.save(createItem("123", { message: "save" }));

      const fetched = await repository.get("123");
      expect(fetched).toEqual({ id: "123", name: `Test Item 123`, message: "save" });
    });

    describe("with schema", () => {
      beforeEach(() => {
        repository = new DatastoreRepository<RepositoryItem>(collection, {
          datastore,
          validator,
        });
      });

      it("saves document outside of transaction that matches schema", async () => {
        await repository.save([createItem("123"), createItem("234")]);

        const fetched = await repository.get(["123", "234"]);
        expect(fetched.length).toBe(2);
        expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123` });
      });

      it("throws for document that doesn't match schema", async () => {
        const abc = { id: "123", message: "no name" } as any as RepositoryItem;
        await expect(repository.save(abc)).rejects.toThrow('"repository-items" with id "123" failed to save');
      });
    });
  });

  describe("insert", () => {
    it("inserts documents outside of transaction", async () => {
      await repository.insert([createItem("123"), createItem("234")]);

      const fetched = await repository.get(["123", "234"]);
      expect(fetched.length).toBe(2);
      expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123` });
    });

    it("inserts documents in transaction", async () => {
      await runWithRequestStorage(async () => {
        datastoreLoaderRequestStorage.set(new DatastoreLoader(datastore));
        return runInTransaction(() => repository.insert([createItem("123"), createItem("234")]));
      });

      const fetched = await repository.get(["123", "234"]);
      expect(fetched.length).toBe(2);
      expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123` });
    });

    it("throws inserting document with id that already exists", async () => {
      await repository.insert(createItem("123", { message: "insert" }));
      await expect(repository.insert(createItem("123", { message: "insert again" }))).rejects.toThrow("ALREADY_EXISTS");
    });

    describe("with schema", () => {
      beforeEach(() => {
        repository = new DatastoreRepository<RepositoryItem>(collection, {
          datastore,
          validator,
        });
      });

      it("inserts documents outside of transaction that match schema", async () => {
        await repository.insert([createItem("123"), createItem("234")]);

        const fetched = await repository.get(["123", "234"]);
        expect(fetched.length).toBe(2);
        expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123` });
      });

      it("throws for document that doesn't match schema", async () => {
        const abc = { id: "123", message: "no name" } as any as RepositoryItem;
        await expect(repository.insert(abc)).rejects.toThrow('"repository-items" with id "123" failed to save');
      });
    });
  });

  describe("update", () => {
    it("updates documents outside of transaction", async () => {
      await repository.insert([createItem("123", { message: "create" }), createItem("234", { message: "create" })]);

      await repository.update([createItem("123", { message: "update" }), createItem("234", { message: "update" })]);

      const fetched = await repository.get(["123", "234"]);
      expect(fetched.length).toBe(2);
      expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123`, message: "update" });
    });

    it("updates documents in transaction", async () => {
      await repository.insert([createItem("123", { message: "create" }), createItem("234", { message: "create" })]);

      await runWithRequestStorage(async () => {
        datastoreLoaderRequestStorage.set(new DatastoreLoader(datastore));
        return runInTransaction(async () =>
          repository.update([createItem("123", { message: "update" }), createItem("234", { message: "update" })])
        );
      });

      const fetched = await repository.get(["123", "234"]);
      expect(fetched.length).toBe(2);
      expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123`, message: "update" });
    });

    describe("with schema", () => {
      beforeEach(async () => {
        repository = new DatastoreRepository<RepositoryItem>(collection, {
          datastore,
          validator,
        });
        await repository.insert([createItem("123", { message: "create" }), createItem("234", { message: "create" })]);
      });

      it("updates document outside of transaction that matches schema", async () => {
        await repository.update([createItem("123", { message: "update" }), createItem("234", { message: "update" })]);

        const fetched = await repository.get(["123", "234"]);
        expect(fetched.length).toBe(2);
        expect(fetched[0]).toEqual({ id: "123", name: `Test Item 123`, message: "update" });
      });

      it("throws for document that doesn't match schema", async () => {
        const abc = { id: "123", message: "no name" } as any as RepositoryItem;
        await expect(repository.save(abc)).rejects.toThrow('"repository-items" with id "123" failed to save');
      });
    });
  });

  describe("delete", () => {
    it("deletes a document outside of transaction", async () => {
      await insertItem("123");

      await repository.delete("123");

      const [doc] = await datastore.get(itemKey("123"));
      expect(doc).toBe(undefined);
    });

    it("deletes a document in transaction", async () => {
      await insertItem("123");
      await insertItem("234");

      await runWithRequestStorage(async () => {
        datastoreLoaderRequestStorage.set(new DatastoreLoader(datastore));
        return runInTransaction(() => repository.delete("123", "234"));
      });

      const [doc123] = await datastore.get(itemKey("123"));
      expect(doc123).toBe(undefined);
      const [doc234] = await datastore.get(itemKey("234"));
      expect(doc234).toBe(undefined);
    });
  });

  describe("query", () => {
    beforeEach(() => {
      repository = new DatastoreRepository<RepositoryItem>(collection, {
        datastore,
        validator,
        index: {
          name: true,
          prop1: true,
          prop2: true,
          prop3: true,
          propArray: true,
        },
      });
    });

    it("filters by exact match", async () => {
      await repository.save([createItem("123"), createItem("234")]);

      const [results] = await repository.query({
        filters: {
          name: "Test Item 234",
        },
      });

      expect(results.length).toBe(1);
      expect(results[0].name).toEqual("Test Item 234");
    });

    it("filters by array match using short filter", async () => {
      await repository.save([
        createItem("123", { propArray: ["ROLE_1", "ROLE_2"] }),
        createItem("234", { propArray: ["ROLE_1", "ROLE_3"] }),
      ]);

      const [results] = await repository.query({
        filters: { propArray: "ROLE_3" },
      });

      expect(results.length).toBe(1);
      expect(results[0].name).toEqual("Test Item 234");
    });

    it("filters by array match using complex filter", async () => {
      await repository.save([
        createItem("123", { propArray: ["ROLE_1", "ROLE_2"] }),
        createItem("234", { propArray: ["ROLE_1", "ROLE_3"] }),
      ]);

      const [results] = await repository.query({
        filters: { propArray: { op: "=", value: "ROLE_2" } },
      });

      expect(results.length).toBe(1);
      expect(results[0].name).toEqual("Test Item 123");
    });

    it("selects specific fields", async () => {
      await repository.save([
        createItem("123", { prop1: "prop1", prop2: "prop2", prop3: "prop3" }),
        createItem("234", { prop1: "prop1", prop2: "prop2", prop3: "prop3" }),
      ]);

      const [results] = await repository.query({
        select: ["prop1", "prop3"],
      });

      expect(results.length).toBe(2);
      expect(results[0].prop1).toEqual("prop1");
      expect(results[0].prop2).toBeUndefined();
      expect(results[0].prop3).toEqual("prop3");
    });

    it("selects everything when empty projection query", async () => {
      await repository.save([
        createItem("123", { prop1: "prop1", prop2: "prop2", prop3: "prop3" }),
        createItem("234", { prop1: "prop1", prop2: "prop2", prop3: "prop3" }),
      ]);
      const [results] = await repository.query({ select: [] });

      expect(results.length).toEqual(2);
      expect(results[0]).toEqual({ id: "123", name: "Test Item 123", prop1: "prop1", prop2: "prop2", prop3: "prop3" });
    });

    it("selects ids only when  projection query", async () => {
      await repository.save([
        createItem("123", { prop1: "prop1", prop2: "prop2", prop3: "prop3" }),
        createItem("234", { prop1: "prop1", prop2: "prop2", prop3: "prop3" }),
      ]);
      const [results] = await repository.query({ select: ["__key__"] });

      expect(results).toEqual([{ id: "123" }, { id: "234" }]);
    });

    describe("limit and offset", () => {
      beforeEach(async () => {
        await repository.save([
          createItem("123", { prop1: "user1" }),
          createItem("234", { prop1: "user2" }),
          createItem("345", { prop1: "user3" }),
          createItem("456", { prop1: "user4" }),
          createItem("567", { prop1: "user5" }),
        ]);
      });

      it("applies limit", async () => {
        const [results] = await repository.query({
          limit: 3,
        });

        expect(results.length).toBe(3);
      });

      it("applies offset", async () => {
        const [results] = await repository.query({
          offset: 3,
        });

        expect(results.length).toBe(2);
        expect(results[0].id).toEqual("456");
      });

      it("applies limit and offset", async () => {
        const [results] = await repository.query({
          limit: 2,
          offset: 2,
        });

        expect(results.length).toBe(2);
        expect(results[0].id).toEqual("345");
        expect(results[1].id).toEqual("456");
      });
    });

    describe("ordering", () => {
      beforeEach(async () => {
        await repository.save([
          createItem("123", { prop1: "AA", prop2: "XX" }),
          createItem("234", { prop1: "BA", prop2: "XX" }),
          createItem("345", { prop1: "AB", prop2: "ZZ" }),
          createItem("456", { prop1: "BB", prop2: "YY" }),
          createItem("567", { prop1: "CA", prop2: "XX" }),
        ]);
      });

      it("orders results ascending", async () => {
        const [results] = await repository.query({
          sort: {
            property: "prop1",
            options: {
              descending: false,
            },
          },
        });

        expect(results.length).toBe(5);
        expect(results.map((doc) => doc.id)).toEqual(["123", "345", "234", "456", "567"]);
      });

      it("orders results descending", async () => {
        const [results] = await repository.query({
          sort: {
            property: "prop1",
            options: {
              descending: true,
            },
          },
        });

        expect(results.length).toBe(5);
        expect(results.map((doc) => doc.id)).toEqual(["567", "456", "234", "345", "123"]);
      });

      it("orders by multiple fields", async () => {
        const [results] = await repository.query({
          sort: [
            {
              property: "prop2",
              options: {
                descending: false,
              },
            },
            {
              property: "prop1",
              options: {
                descending: true,
              },
            },
          ],
        });

        expect(results.length).toBe(5);
        expect(results.map((doc) => doc.id)).toEqual(["567", "234", "123", "456", "345"]);
      });

      it("orders results by id special key", async () => {
        const [results] = await repository.query({
          sort: [{ property: "prop2" }, { property: "__key__" }],
        });

        expect(results.length).toBe(5);
        expect(results.map((doc) => doc.id)).toEqual(["123", "234", "567", "456", "345"]);
      });
    });

    describe("cursors", () => {
      beforeEach(async () => {
        await repository.save([
          createItem("123", { prop1: "msg1" }),
          createItem("234", { prop1: "msg2" }),
          createItem("345", { prop1: "msg1" }),
          createItem("456", { prop1: "msg2" }),
          createItem("567", { prop1: "msg1" }),
        ]);
      });

      it("applies start cursor", async () => {
        const [, queryInfo] = await repository.query({
          sort: { property: "name" },
          limit: 2,
        });

        const [results] = await repository.query({
          sort: { property: "name" },
          start: queryInfo.endCursor,
        });

        expect(results.length).toBe(3);
        expect(results[0].name).toEqual("Test Item 345");
      });

      it("applies end cursor", async () => {
        const [, queryInfo] = await repository.query({
          sort: { property: "name" },
          limit: 3,
        });

        const [results] = await repository.query({
          sort: { property: "name" },
          end: queryInfo.endCursor,
        });

        expect(results.length).toBe(3);
        expect(results[0].name).toEqual("Test Item 123");
      });
    });
  });

  describe("with search enabled", () => {
    const searchService: SearchService = {
      index: jest.fn(),
      delete: jest.fn(),
      deleteAll: jest.fn(),
      query: jest.fn(),
    };

    const initRepo = (indexConfig: IndexConfig<RepositoryItem>): DatastoreRepository<RepositoryItem> =>
      new DatastoreRepository<RepositoryItem>(collection, {
        datastore,
        validator,
        search: {
          searchService: searchService,
          indexName: "item",
          indexConfig,
        },
      });

    const createItem = (id: string): RepositoryItem => ({
      id,
      name: id,
      prop1: `${id}_prop1`,
      prop2: `${id}_prop2`,
      prop3: `${id}_prop3`,
      nested: {
        prop4: `${id}_prop4`,
      },
    });

    beforeEach(() => {
      jest.resetAllMocks();
      repository = initRepo({
        prop1: true,
        prop2: (value) => value.prop2?.toUpperCase(),
        nested: true,
        custom: (value) => `custom_${value.prop3}`,
      });
    });

    const itIndexesEntitiesForOperation = (operation: string) => {
      const verifyIndexEntries = (entries: IndexEntry[]) => {
        expect(searchService.index).toHaveBeenCalledWith("item", entries);
      };

      it("indexes fields in repository config (single item)", async () => {
        const item = createItem("item1");

        await (repository as any)[operation](item);

        verifyIndexEntries([
          {
            id: "item1",
            fields: {
              prop1: "item1_prop1",
              prop2: "ITEM1_PROP2",
              nested: {
                prop4: "item1_prop4",
              },
              custom: "custom_item1_prop3",
            },
          },
        ]);
      });

      it("indexes fields in repository config (multiple items)", async () => {
        const item1 = createItem("item1");
        const item2 = createItem("item2");

        await (repository as any)[operation]([item1, item2]);

        verifyIndexEntries([
          {
            id: "item1",
            fields: {
              prop1: "item1_prop1",
              prop2: "ITEM1_PROP2",
              nested: {
                prop4: "item1_prop4",
              },
              custom: "custom_item1_prop3",
            },
          },
          {
            id: "item2",
            fields: {
              prop1: "item2_prop1",
              prop2: "ITEM2_PROP2",
              nested: {
                prop4: "item2_prop4",
              },
              custom: "custom_item2_prop3",
            },
          },
        ]);
      });
    };

    describe("save", () => {
      itIndexesEntitiesForOperation("save");
    });

    describe("update", () => {
      beforeEach(async () => {
        await insertItem("item1");
        await insertItem("item2");
      });
      itIndexesEntitiesForOperation("update");
    });

    describe("insert", () => {
      itIndexesEntitiesForOperation("insert");
    });

    describe("upsert", () => {
      itIndexesEntitiesForOperation("upsert");
    });

    describe("delete", () => {
      it("requests index deletion (single item)", async () => {
        await repository.delete("item1");

        expect(searchService.delete).toHaveBeenCalledWith("item", "item1");
      });

      it("requests index deletion (multiple items)", async () => {
        await repository.delete("item1", "item2");

        expect(searchService.delete).toHaveBeenCalledWith("item", "item1", "item2");
      });
    });

    describe("deleteAll", () => {
      it("requests search index deletion of all items", async () => {
        await repository.deleteAll();

        expect(searchService.deleteAll).toHaveBeenCalledWith("item");
      });
    });

    describe("search", () => {
      it("searches and fetches results", async () => {
        const searchFields: SearchFields = {
          prop1: "prop1",
        };
        const sort: Sort = {
          field: "prop1",
        };
        const page: Page = {
          limit: 10,
          offset: 10,
        };

        (searchService as any).query.mockImplementation(async () => ({
          resultCount: 2,
          limit: 10,
          offset: 10,
          ids: ["item1", "item2"],
        }));

        await repository.save([createItem("item1"), createItem("item2")]);

        const results = await repository.search(searchFields, sort, page);

        expect(results).toEqual({
          resultCount: 2,
          limit: 10,
          offset: 10,
          results: expect.arrayContaining([
            expect.objectContaining({ id: "item1" }),
            expect.objectContaining({ id: "item2" }),
          ]),
        });
      });
    });
  });
});
