var defineConfig = require('prisma/config').defineConfig;
var databaseUrl = process.env.DATABASE_URL || 'file:./dev.db';
// SQLite URL format must start with file:
var effectiveUrl = databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('mysql://')
    ? databaseUrl
    : "file:./dev.db";
module.exports = defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
    },
    // Prisma 7: use runtime config via env var in schema instead
});
