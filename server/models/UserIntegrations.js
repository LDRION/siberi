const mongoose = require('mongoose');

const tgContactSchema = new mongoose.Schema({
  chatId:      { type: String, required: true },
  username:    { type: String, default: '' },
  displayName: { type: String, default: '' },
  lastSeen:    { type: Date, default: Date.now },
}, { _id: false });

const botInstanceSchema = new mongoose.Schema({
  name:          { type: String, default: '' },
  token:         String,
  botUsername:   String,
  botName:       String,
  profileId:     { type: mongoose.Schema.Types.ObjectId, ref: 'UserAiConfig', default: null },
  connected:     { type: Boolean, default: false },
  connectedAt:   Date,
  knownContacts: { type: [tgContactSchema], default: [] },
  // Shared-secret query param for the generic payment webhook receiver
  // (routes/webhooks.js POST /webhook/payment/:userId/:instanceId) — the only
  // protection on that URL besides the unguessable ObjectIds, since end users'
  // own payment-provider secrets aren't something Siberi has access to.
  paymentWebhookSecret: { type: String, default: null },
}, { _id: true });

const vkInstanceSchema = new mongoose.Schema({
  name:          { type: String, default: '' },
  token:         String,
  groupId:       String,
  confirmString: String,
  secret:        String,
  profileId:     { type: mongoose.Schema.Types.ObjectId, ref: 'UserAiConfig', default: null },
  connected:     { type: Boolean, default: false },
  connectedAt:   Date,
}, { _id: true });

const userIntegrationsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    google: {
      connected:    { type: Boolean, default: false },
      email:        String,
      accessToken:  String,
      refreshToken: String,
      expiryDate:   Number,
      connectedAt:  Date,
    },
    telegram: { type: [botInstanceSchema], default: [] },
    vk:       { type: [vkInstanceSchema],  default: [] },
    max:      { type: [botInstanceSchema], default: [] },
    webhookCallback: {
      enabled: { type: Boolean, default: false },
      url:     String,
    },
    onec: {
      enabled:       { type: Boolean, default: false },
      webhookToken:  String,
      schemaName:    String,
      mode:          { type: String, enum: ['webhook', 'odata'], default: 'webhook' },
      odataUrl:      String,
      odataLogin:    String,
      odataPassword: String,
      odataEntity:   String,
      lastSync:      Date,
      lastSyncCount: Number,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserIntegrations', userIntegrationsSchema);
