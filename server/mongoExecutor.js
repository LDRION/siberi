const { MongoClient, ObjectId } = require('mongodb');

async function getMongoClient() {
  const client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  return client;
}

module.exports = { getMongoClient, ObjectId };
