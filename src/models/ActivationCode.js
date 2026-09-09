const mongoose = require("mongoose");

const activationCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true
    },
    isActivated: {
      type: Boolean,
      default: false
    },
    deviceId: {
      type: String,
      default: null,
      trim: true,
      index: true
    },
    isBlocked: {
      type: Boolean,
      default: false,
      index: true
    },
    durationLabel: {
      type: String,
      default: ""
    },
    activatedAt: {
      type: Date,
      default: null
    },
    lastSeenAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

activationCodeSchema.methods.isExpired = function isExpired(now = new Date()) {
  return this.expiresAt.getTime() <= now.getTime();
};

activationCodeSchema.methods.toPublicJson = function toPublicJson() {
  return {
    code: this.code,
    expiresAt: this.expiresAt,
    isActivated: this.isActivated,
    deviceId: this.deviceId,
    isBlocked: this.isBlocked
  };
};

module.exports = mongoose.model("ActivationCode", activationCodeSchema);
