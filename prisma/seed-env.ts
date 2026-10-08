// Evaluated before any other seed import: the seed never talks to Redis.
process.env.QUEUE_DISABLED = "1";
