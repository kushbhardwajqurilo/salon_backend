import {
  validateTestDatabaseUri,
  getIsolatedTestMongoUri,
  REGISTERED_SUITE_SUFFIXES,
  FORBIDDEN_APPLICATION_DB_NAMES,
} from "./testSetup.js";

describe("Test Database Safety Guard Verification", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Host-level protection", () => {
    it("1. strictly rejects localhost and 127.0.0.1 under Atlas-only architecture", () => {
      process.env.NODE_ENV = "test";
      delete process.env.TEST_MONGO_ALLOWED_HOSTS;

      expect(() =>
        validateTestDatabaseUri("mongodb://localhost:27017/saloon_erp_test_sub_test")
      ).toThrow(/Invalid MongoDB URI protocol: 'mongodb:'.*all connections must use 'mongodb\+srv:\/\/'/);

      expect(() =>
        validateTestDatabaseUri("mongodb://127.0.0.1:27017/saloon_erp_test_sub_test")
      ).toThrow(/Invalid MongoDB URI protocol: 'mongodb:'.*all connections must use 'mongodb\+srv:\/\/'/);

      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://user:pass@127.0.0.1/saloon_erp_test_sub_test?replicaSet=rs0"
        )
      ).toThrow(/Local MongoDB host '127\.0\.0\.1' is strictly forbidden/);

      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://user:pass@localhost/saloon_erp_test_sub_test"
        )
      ).toThrow(/Local MongoDB host 'localhost' is strictly forbidden/);
    });

    it("2. accepts valid Atlas test cluster (*.mongodb.net)", () => {
      process.env.NODE_ENV = "test";
      delete process.env.TEST_MONGO_ALLOWED_HOSTS;

      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://test_user:test_password@test-cluster.example.mongodb.net/saloon_erp_test_billing_test"
        )
      ).not.toThrow();
    });

    it("3. rejects any non-Atlas host ending unconditionally", () => {
      process.env.NODE_ENV = "test";

      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://test_user:test_password@custom-test-host.net/saloon_erp_test_billing_test"
        )
      ).toThrow(/Non-Atlas MongoDB host 'custom-test-host\.net' is not authorized.*Tests must target a valid MongoDB Atlas cluster ending in '\*\.mongodb\.net'/);
    });

    it("4. rejects standard mongodb:// protocol, enforcing mongodb+srv:// exclusively", () => {
      process.env.NODE_ENV = "test";

      expect(() =>
        validateTestDatabaseUri(
          "mongodb://user:pass@test-cluster.example.mongodb.net/saloon_erp_test_sub_test"
        )
      ).toThrow(/Invalid MongoDB URI protocol: 'mongodb:'.*all connections must use 'mongodb\+srv:\/\/'/);
    });

    it("5. enforces that host must end in .mongodb.net", () => {
      process.env.NODE_ENV = "test";

      // 'evilcluster.mongodb.com' should be rejected
      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://user:pass@evilcluster.mongodb.com/saloon_erp_test_sub_test"
        )
      ).toThrow(/Non-Atlas MongoDB host 'evilcluster\.mongodb\.com' is not authorized/);

      // 'otherhost.org' should be rejected
      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://user:pass@otherhost.org/saloon_erp_test_sub_test"
        )
      ).toThrow(/Non-Atlas MongoDB host 'otherhost\.org' is not authorized/);
    });

    it("6. rejects plain unencrypted loopback addresses", () => {
      process.env.NODE_ENV = "test";

      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://user:pass@localhost/saloon_erp_test_sub_test"
        )
      ).toThrow(/Local MongoDB host 'localhost' is strictly forbidden/);

      expect(() =>
        validateTestDatabaseUri(
          "mongodb+srv://user:pass@127.0.0.1/saloon_erp_test_sub_test"
        )
      ).toThrow(/Local MongoDB host '127\.0\.0\.1' is strictly forbidden/);
    });

    it("7. does not log credentials or URI in rejection messages", () => {
      process.env.NODE_ENV = "test";
      delete process.env.TEST_MONGO_ALLOWED_HOSTS;
      const secretPassword = "superSecretPassword123";

      try {
        validateTestDatabaseUri(
          `mongodb+srv://admin:${secretPassword}@untrusted-cluster.net/saloon_erp_test_sub_test`
        );
        expect(true).toBe(false); // Should have thrown
      } catch (err) {
        expect(err.message).not.toContain(secretPassword);
        expect(err.message).not.toContain("mongodb+srv://");
      }
    });
  });

  describe("Core validation rules", () => {
    it("8. rejects execution when TEST_MONGO_URI is missing", () => {
      delete process.env.TEST_MONGO_URI;
      expect(() => getIsolatedTestMongoUri("billing_test")).toThrow(
        /Explicit TEST_MONGO_URI environment variable is required/
      );
      expect(() => validateTestDatabaseUri("")).toThrow(
        /Explicit TEST_MONGO_URI is required/
      );
    });

    it("9. rejects execution when NODE_ENV=production", () => {
      process.env.NODE_ENV = "production";
      process.env.TEST_MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_test";
      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp_test_sub_test")
      ).toThrow(/NODE_ENV === 'production'/);
    });

    it("10. rejects invalid MongoDB URI syntax or protocol", () => {
      process.env.NODE_ENV = "test";
      expect(() => validateTestDatabaseUri("not-a-url")).toThrow(
        /Invalid MongoDB URI provided/
      );
      expect(() => validateTestDatabaseUri("http://test.mongodb.net/test_db")).toThrow(
        /Invalid MongoDB URI provided|Invalid MongoDB URI protocol/
      );
      expect(() => validateTestDatabaseUri("mongodb+srv://test.mongodb.net")).toThrow(
        /must explicitly specify a database path/
      );
    });

    it("11. rejects all forbidden application database names, including saloon_erp_test and saloon_erp_dev", () => {
      process.env.NODE_ENV = "test";

      for (const forbidden of FORBIDDEN_APPLICATION_DB_NAMES) {
        expect(() =>
          validateTestDatabaseUri(`mongodb+srv://test.example.mongodb.net/${forbidden}`)
        ).toThrow(new RegExp(`Refusing to connect to application/development database '${forbidden}'`));
      }

      // Explicitly verify the key ones
      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp")
      ).toThrow(/Refusing to connect to application\/development database 'saloon_erp'/);

      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp_test")
      ).toThrow(/Refusing to connect to application\/development database 'saloon_erp_test'/);

      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp_dev")
      ).toThrow(/Refusing to connect to application\/development database 'saloon_erp_dev'/);
    });

    it("12. rejects unsuffixed databases even when their name contains 'test'", () => {
      process.env.NODE_ENV = "test";
      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/random_test_database")
      ).toThrow(/not a recognized isolated suite database.*Unsuffixed databases are strictly forbidden/);

      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp_test")
      ).toThrow(/Refusing to connect to application\/development database 'saloon_erp_test'/);
    });

    it("13. rejects collision when test URI and application MONGO_URI target the exact same database", () => {
      process.env.NODE_ENV = "test";
      process.env.MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_test_sub_test";

      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp_test_sub_test")
      ).toThrow(/Collision detected: Test URI targets the exact same database/);
    });

    it("14. accepts the same cluster when the database names are distinct", () => {
      process.env.NODE_ENV = "test";
      process.env.MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_dev";

      expect(() =>
        validateTestDatabaseUri("mongodb+srv://test.example.mongodb.net/saloon_erp_test_sub_test")
      ).not.toThrow();
    });
  });

  describe("Suite namespace isolation via getIsolatedTestMongoUri", () => {
    it("15. rejects empty, missing, or whitespace suiteSuffix", () => {
      process.env.NODE_ENV = "test";
      process.env.TEST_MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_test";

      expect(() => getIsolatedTestMongoUri()).toThrow(/Non-empty suiteSuffix is required/);
      expect(() => getIsolatedTestMongoUri("")).toThrow(/Non-empty suiteSuffix is required/);
      expect(() => getIsolatedTestMongoUri("   ")).toThrow(/Non-empty suiteSuffix is required/);
    });

    it("16. rejects unregistered suite suffixes", () => {
      process.env.NODE_ENV = "test";
      process.env.TEST_MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_test";

      expect(() => getIsolatedTestMongoUri("unregistered_random_suffix")).toThrow(
        /Invalid suiteSuffix 'unregistered_random_suffix'/
      );
    });

    it("17. generates distinct, valid database names for registered suite suffixes", () => {
      process.env.NODE_ENV = "test";
      process.env.TEST_MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_test";

      const uriA = getIsolatedTestMongoUri("billing_test");
      const uriB = getIsolatedTestMongoUri("loyalty_test");

      expect(uriA).toBe("mongodb+srv://test.example.mongodb.net/saloon_erp_test_billing_test");
      expect(uriB).toBe("mongodb+srv://test.example.mongodb.net/saloon_erp_test_loyalty_test");
      expect(uriA).not.toBe(uriB);
    });

    it("18. preserves credentials, hostname, and query parameters on Atlas SRV URI", () => {
      process.env.NODE_ENV = "test";
      process.env.TEST_MONGO_URI =
        "mongodb+srv://testUser:testPass123@test.example.mongodb.net/saloon_erp_test?retryWrites=true&w=majority";

      const isolated = getIsolatedTestMongoUri("multi_sub_test");
      expect(isolated).toContain("mongodb+srv://testUser:testPass123@test.example.mongodb.net/saloon_erp_test_multi_sub_test?");
      expect(isolated).toContain("retryWrites=true");
      expect(isolated).toContain("w=majority");
    });

    it("19. accepts every single registered suite suffix from REGISTERED_SUITE_SUFFIXES", () => {
      process.env.NODE_ENV = "test";
      process.env.TEST_MONGO_URI = "mongodb+srv://test.example.mongodb.net/saloon_erp_test";

      for (const suffix of REGISTERED_SUITE_SUFFIXES) {
        expect(() => getIsolatedTestMongoUri(suffix)).not.toThrow();
      }
    });
  });

  describe("Connection mechanism protection", () => {
    it("20. protects mongoose.connect from connecting to unallowed remote host, application db, or unsuffixed db", async () => {
      const mongoose = (await import("mongoose")).default;
      process.env.NODE_ENV = "test";
      delete process.env.TEST_MONGO_ALLOWED_HOSTS;

      expect(() => {
        mongoose.connect("mongodb+srv://prod_host.net/saloon_erp_test_sub_test");
      }).toThrow(/Non-Atlas MongoDB host 'prod_host\.net' is not authorized/);

      expect(() => {
        mongoose.connect("mongodb+srv://test.example.mongodb.net/saloon_erp");
      }).toThrow(/Refusing to connect to application\/development database 'saloon_erp'/);

      expect(() => {
        mongoose.connect("mongodb+srv://test.example.mongodb.net/saloon_erp_test");
      }).toThrow(/Refusing to connect to application\/development database 'saloon_erp_test'/);

      expect(() => {
        mongoose.connect("mongodb+srv://test.example.mongodb.net/saloon_erp_dev");
      }).toThrow(/Refusing to connect to application\/development database 'saloon_erp_dev'/);

      expect(() => {
        mongoose.connect("mongodb://127.0.0.1:27017/saloon_erp_test_sub_test");
      }).toThrow(/Invalid MongoDB URI protocol: 'mongodb:'.*all connections must use 'mongodb\+srv:\/\/'/);

      expect(() => {
        mongoose.connect("mongodb+srv://127.0.0.1/saloon_erp_test_sub_test");
      }).toThrow(/Local MongoDB host '127\.0\.0\.1' is strictly forbidden/);
    });

    it("21. protects mongoose.createConnection from connecting to unallowed remote host or forbidden db", async () => {
      const mongoose = (await import("mongoose")).default;
      process.env.NODE_ENV = "test";
      delete process.env.TEST_MONGO_ALLOWED_HOSTS;

      expect(() => {
        mongoose.createConnection("mongodb+srv://evil.net/saloon_erp_test_sub_test");
      }).toThrow(/Non-Atlas MongoDB host 'evil\.net' is not authorized/);

      expect(() => {
        mongoose.createConnection("mongodb+srv://test.example.mongodb.net/saloon_erp_test");
      }).toThrow(/Refusing to connect to application\/development database 'saloon_erp_test'/);

      expect(() => {
        mongoose.createConnection("mongodb://localhost:27017/saloon_erp_test_sub_test");
      }).toThrow(/Invalid MongoDB URI protocol: 'mongodb:'.*all connections must use 'mongodb\+srv:\/\/'/);

      expect(() => {
        mongoose.createConnection("mongodb+srv://localhost/saloon_erp_test_sub_test");
      }).toThrow(/Local MongoDB host 'localhost' is strictly forbidden/);
    });
  });
});
