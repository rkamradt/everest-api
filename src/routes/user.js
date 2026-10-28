'use strict';

const express = require('express');
const { User } = require('../db');

const router = express.Router();

// GET /api/user/profile
router.get('/profile', async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const user = await User.findOne({ userId });
    res.json({
      hasApiKey: !!(user?.anthropicApiKey),
      anthropicModel: user?.anthropicModel || 'claude-sonnet-4-6',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/user/profile
router.put('/profile', async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { anthropicApiKey, anthropicModel } = req.body;

    if (anthropicApiKey && !anthropicApiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'anthropicApiKey must start with "sk-"' });
    }

    const update = { updatedAt: new Date() };
    if (anthropicApiKey) update.anthropicApiKey = anthropicApiKey;
    if (anthropicModel) update.anthropicModel = anthropicModel;

    await User.findOneAndUpdate({ userId }, { $set: update }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
