class Sqs {
  constructor ({ config, sqs }) {
    this.sqs = sqs
    this.config = config
  }

  async distributeOrgDonation (payload) {
    const url = this.config.getDistributeOrgDonationQueueUrl()
    return this.sendMessage(url, payload)
  }

  async sendMessage (url, payload) {
    return this.sqs.sendMessage({
      QueueUrl: url,
      MessageBody: JSON.stringify(payload)
    }).promise()
  }
}

module.exports = Sqs
