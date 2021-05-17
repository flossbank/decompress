const test = require('ava')
const sinon = require('sinon')
const SQS = require('../lib/sqs')

test.before((t) => {
  t.context.sqs = new SQS({
    sqs: {
      sendMessage: sinon.stub().returns({
        promise: sinon.stub().resolves()
      })
    },
    config: {
      getDistributeOrgDonationQueueUrl: sinon.stub().returns('url')
    }
  })
})

test('distributeOrgDonation: sends a message to the queue', async (t) => {
  const { sqs } = t.context
  await sqs.distributeOrgDonation({
    help: 'me'
  })

  t.true(sqs.sqs.sendMessage.calledWith({
    QueueUrl: 'url',
    MessageBody: JSON.stringify({ help: 'me' })
  }))
})
