const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  type:     { type: String, enum: ['registration', 'payment'], required: true },
  joinedAt: { type: Date, required: true }, // registration date of the referred user
  amount:   Number,
  plan:     String,
  read:     { type: Boolean, default: false },
  createdAt:{ type: Date, default: Date.now },
}, { _id: true });

const payoutSchema = new mongoose.Schema({
  amount:         { type: Number, required: true },
  paymentDetails: { type: String, required: true },
  status:         { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt:    { type: Date, default: Date.now },
  processedAt:    Date,
  adminNote:      String,
}, { _id: true });

const referralSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt:        { type: Date, default: Date.now },
  totalPaid:       { type: Number, default: 0 },
  earned:          { type: Number, default: 0 },
  firstPaymentDone:{ type: Boolean, default: false },
}, { _id: false });

const affiliateSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  referralCode:   { type: String, required: true, unique: true, index: true, uppercase: true },
  balance:        { type: Number, default: 0 },
  totalEarned:    { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  referrals:      [referralSchema],
  payouts:        [payoutSchema],
  notifications:  [notificationSchema],
  joinedAt:       { type: Date, default: Date.now },
});

module.exports = mongoose.model('UserAffiliate', affiliateSchema);
