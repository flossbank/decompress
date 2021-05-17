const test = require('ava')
const sinon = require('sinon')
const { MongoMemoryServer } = require('mongodb-memory-server')
const Config = require('../lib/config')
const Mongo = require('../lib/mongo')

test.before(async (t) => {
  const config = new Config({ kms: {} })

  const mongo = new MongoMemoryServer()
  const mongoUri = await mongo.getUri()
  config.decrypt = sinon.stub().returns(mongoUri)

  t.context.Mongo = new Mongo({ config, log: { info: sinon.stub() } })

  await t.context.Mongo.connect()
})

test.after(async (t) => {
  await t.context.Mongo.close()
})

test('close', async (t) => {
  const mongo = new Mongo({})
  await mongo.close() // nothing to close here
  mongo.mongoClient = { close: sinon.stub() }
  await mongo.close()
  t.true(mongo.mongoClient.close.calledOnce)
})
