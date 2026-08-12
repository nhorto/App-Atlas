const express = require('express');

module.exports = function setupMembersApp() {
  const membersApp = express.Router();

  membersApp.get('/api/session', (req, res) => res.json({}));

  return membersApp;
};
