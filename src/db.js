'use strict';

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  anthropicApiKey: { type: String },
  anthropicModel: { type: String, default: 'claude-sonnet-4-6' },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);

async function connect() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/everest';
  await mongoose.connect(uri);
  console.log(`MongoDB connected: ${uri}`);
}

module.exports = { connect, User };
