import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod;

export async function startMongo() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

export async function stopMongo() {
  await mongoose.disconnect();
  await mongod.stop();
}

export async function resetDb() {
  await mongoose.connection.db.dropDatabase();
}
