const test = require('ava')
const sinon = require('sinon')
const { MongoMemoryServer } = require('mongodb-memory-server')
const Config = require('../lib/config')
const Mongo = require('../lib/mongo')
const Process = require('../lib/process')
const { ulid } = require('ulid')

test.before(async (t) => {
  sinon.stub(Date, 'now').returns(1234)

  t.context.log = { info: sinon.stub() }
  t.context.sqs = { distributeOrgDonation: sinon.stub() }

  const config = new Config({ kms: {} })

  const mongo = new MongoMemoryServer()
  const mongoUri = await mongo.getUri()
  config.decrypt = sinon.stub().returns(mongoUri)

  t.context.db = new Mongo({ config, log: { info: sinon.stub() } })
  await t.context.db.connect()

  const { db } = t.context.db

  await db.collection('meta').insertOne({
    name: 'noCompList',
    language: 'javascript',
    registry: 'npm',
    list: ['papajohns', 'greasy']
  })
  await db.collection('meta').insertOne({
    name: 'noCompList',
    language: 'ruby',
    registry: 'rubygems',
    list: ['roobs']
  })

  const { insertedId: orgId1 } = await db.collection('organizations').insertOne({ name: 'frostbank' })
  const { insertedId: orgId2 } = await db.collection('organizations').insertOne({ name: 'squirm' })

  t.context.orgId1 = orgId1
  t.context.orgId2 = orgId2

  const { insertedId: pkgId1 } = await db.collection('packages').insertOne({
    name: 'papajohns',
    language: 'javascript',
    registry: 'npm',
    adRevenue: [
      {
        id: ulid(),
        amount: 100
      }
    ],
    donationRevenue: [
      {
        id: ulid(),
        organizationId: orgId1.toString(),
        amount: 200,
        description: 'Invoice 2'
      },
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 300,
        description: 'Invoice 22'
      },
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 350,
        description: 'Invoice 23'
      },
      {
        id: ulid(),
        organizationId: orgId1.toString(),
        amount: 1000,
        processed: true,
        description: 'Invoice 1'
      }
    ]
  })
  t.context.pkgId1 = pkgId1

  const { insertedId: pkgId2 } = await db.collection('packages').insertOne({
    name: 'greasy',
    language: 'javascript',
    registry: 'npm',
    adRevenue: [
      {
        id: ulid(),
        amount: 150
      }
    ],
    donationRevenue: [
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 200
      }
    ]
  })
  t.context.pkgId2 = pkgId2

  const { insertedId: pkgId3 } = await db.collection('packages').insertOne({
    name: 'roobs',
    language: 'ruby',
    registry: 'rubygems',
    adRevenue: [
      {
        id: ulid(),
        amount: 150,
        processed: true
      },
      {
        id: ulid(),
        amount: 150,
        processed: true
      }
    ]
  })
  t.context.pkgId3 = pkgId3

  const { insertedId: pkgId4 } = await db.collection('packages').insertOne({
    name: 'will-be-comped',
    language: 'ruby',
    registry: 'rubygems',
    adRevenue: [
      {
        id: ulid(),
        amount: 150
      }
    ],
    donationRevenue: [
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 200
      }
    ]
  })
  t.context.pkgId4 = pkgId4
})

test.after(async (t) => {
  await t.context.db.close()
})

test('process', async (t) => {
  const { db, log, sqs } = t.context

  const result = await Process.process({ db, log, sqs })

  t.is(result.success, true)

  const { pkgId1, pkgId2, pkgId3, pkgId4 } = t.context
  const { orgId1, orgId2 } = t.context

  // it should have updated all the no-comp packages' ad and donation revenue to processed:true
  const noComps = await db.db.collection('packages').find({
    _id: { $in: [pkgId1, pkgId2, pkgId3] }
  }).toArray()
  t.true(noComps.every(pkg => (
    (pkg.donationRevenue || []).every(dono => dono.processed) &&
    (pkg.adRevenue || []).every(ad => ad.processed)
  )))

  // the pkg that wasn't on the no-comp list should still have its revenue
  const pkg4 = await db.db.collection('packages').findOne({ _id: pkgId4 })
  t.true(
    (pkg4.donationRevenue || []).every(dono => !dono.processed) &&
    (pkg4.adRevenue || []).every(ad => !ad.processed)
  )

  // it should have sent an sqs message for each org for each no-comp package with the sum of the org's donations to that pkg

  // for pkg1, there was 200 in unprocessed donos from org1
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: orgId1.toString(),
    amount: 200,
    timestamp: Date.now(),
    targetPackageId: pkgId1.toString(),
    redistributedDonation: true,
    description: 'Invoice 2'
  }))

  // for pkg1, there was 300+350 in unprocessed donos from org2
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: orgId2.toString(),
    amount: 650,
    timestamp: Date.now(),
    targetPackageId: pkgId1.toString(),
    redistributedDonation: true,
    description: 'Invoice 22\nInvoice 23'
  }))

  // for pkg2, there was 200 in unprocessed donos from org2
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: orgId2.toString(),
    amount: 200,
    timestamp: Date.now(),
    targetPackageId: pkgId2.toString(),
    redistributedDonation: true,
    description: ''
  }))

  // nothing for pkg3, since all of its donations were already processed
  const allSqsMessages = sqs.distributeOrgDonation.getCalls()
  t.true(!allSqsMessages.some(({ firstArg: msg }) => msg.targetPackageId === pkgId3.toString()))

  // and nothing for pkg4, since it is not on the no-comp list
  t.true(!allSqsMessages.some(({ firstArg: msg }) => msg.targetPackageId === pkgId4.toString()))
})
