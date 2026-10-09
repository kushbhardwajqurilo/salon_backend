import dns from "node:dns";

// In environments where the default local DNS resolver cannot resolve MongoDB Atlas SRV records,
// explicitly configure reliable public resolvers so test database connections succeed.
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (err) {
  console.warn("Failed to set DNS servers in test setup:", err?.message || err);
}
