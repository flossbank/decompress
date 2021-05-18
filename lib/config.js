class Config {
  constructor ({ kms }) {
    this.kms = kms
    this.configCache = new Map()
  }

  async decrypt (data) {
    return this.kms.decrypt({
      CiphertextBlob: Buffer.from(data, 'base64')
    }).promise().then(decrypted => decrypted.Plaintext.toString())
  }

  async getMongoUri () {
    if (this.configCache.has('mongoUri')) {
      return this.configCache.get('mongoUri')
    }
    const mongoUri = await this.decrypt(process.env.MONGO_URI)
    this.configCache.set('mongoUri', mongoUri)
    return mongoUri
  }

  getDistributeOrgDonationQueueUrl () {
    return process.env.DISTRIBUTE_ORG_DONATIONS_QUEUE_URL
  }

  getFlossbankOrgId () {
    return process.env.FLOSSBANK_ORG_ID
  }
}

module.exports = Config
