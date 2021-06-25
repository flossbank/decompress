const test = require('ava')
const sinon = require('sinon')
const { MongoMemoryServer } = require('mongodb-memory-server')
const Config = require('../lib/config')
const Mongo = require('../lib/mongo')
const Process = require('../lib/process')
const { ulid } = require('ulid')

test.before(async (t) => {
  sinon.stub(Date, 'now').returns(1234)

  t.context.registry = {
    getSpec: (name) => name,
    buildLatestSpec: (name) => name,
    getDependencies: (name) => {
      // for the tests below, greasy (pkg2) has no deps
      if (name === 'greasy') return []
      return ['a-dep']
    }
  }
  t.context.log = { info: sinon.stub() }
  t.context.sqs = { distributeOrgDonation: sinon.stub() }
  t.context.resolver = { getSupportedRegistry: () => t.context.registry }

  const config = new Config({ kms: {} })
  t.context.config = config

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
    list: ['roobs', 'a-fifth-package']
  })

  const { insertedId: orgId1 } = await db.collection('organizations').insertOne({ name: 'frostyback' })
  const { insertedId: orgId2 } = await db.collection('organizations').insertOne({ name: 'squirm' })
  const { insertedId: flossbankOrgId } = await db.collection('organizations').insertOne({ name: 'flossbank' })

  t.context.orgId1 = orgId1
  t.context.orgId2 = orgId2
  t.context.flossbankOrgId = flossbankOrgId

  config.getFlossbankOrgId = () => flossbankOrgId.toString()

  const { insertedId: pkgId1 } = await db.collection('packages').insertOne({
    name: 'papajohns',
    language: 'javascript',
    registry: 'npm',
    adRevenue: [
      {
        id: ulid(),
        amount: 100000
      }
    ],
    donationRevenue: [
      {
        id: ulid(),
        organizationId: orgId1.toString(),
        amount: 200000,
        description: 'Invoice 2'
      },
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 300000,
        description: 'Invoice 22'
      },
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 350000,
        description: 'Invoice 23'
      },
      {
        id: ulid(),
        organizationId: orgId1.toString(),
        amount: 1000000,
        processed: true,
        description: 'Invoice 1'
      },
      {
        id: ulid(),
        userId: 'aaaaaaaaaaaa',
        amount: 1000000,
        description: 'User Dono'
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
        amount: 150000
      }
    ],
    donationRevenue: [
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 200000
      }
    ]
  })
  t.context.pkgId2 = pkgId2

  const { insertedId: pkgId3 } = await db.collection('packages').insertOne({
    name: 'roobs',
    language: 'ruby',
    registry: 'rubygems',
    donationRevenue: [
      {
        id: ulid(),
        amount: 150000,
        organizationId: orgId2.toString(),
        processed: true
      },
      {
        id: ulid(),
        amount: 150000,
        organizationId: orgId2.toString(),
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
        amount: 150000
      }
    ],
    donationRevenue: [
      {
        id: ulid(),
        organizationId: orgId2.toString(),
        amount: 200000
      }
    ]
  })
  t.context.pkgId4 = pkgId4

  // this has no donationRevenue to hit a branch case
  const { insertedId: pkgId5 } = await db.collection('packages').insertOne({
    name: 'a-fifth-package',
    language: 'ruby',
    registry: 'rubygems'
  })
  t.context.pkgId5 = pkgId5
})

test.after(async (t) => {
  await t.context.db.close()
})

test('process', async (t) => {
  const { db, log, sqs, config, resolver } = t.context

  const result = await Process.process({ db, log, sqs, config, resolver })

  t.is(result.success, true)

  const { pkgId1, pkgId2, pkgId3, pkgId4, pkgId5 } = t.context
  const { orgId1, orgId2, flossbankOrgId } = t.context

  // it should have cleared all the no-comp packages' ad and donation revenue
  // it should also tag the package as no-comp
  const noComps = await db.db.collection('packages').find({
    _id: { $in: [pkgId1, pkgId2, pkgId3] }
  }).toArray()
  t.true(noComps.every(pkg => (
    !pkg.donationRevenue &&
    !pkg.adRevenue &&
    pkg.noComp
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
    amount: 200000,
    timestamp: Date.now(),
    targetPackageId: pkgId1.toString(),
    redistributedDonation: true,
    description: 'Invoice 2'
  }))

  // for pkg1, there was 300+350 in unprocessed donos from org2
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: orgId2.toString(),
    amount: 650000,
    timestamp: Date.now(),
    targetPackageId: pkgId1.toString(),
    redistributedDonation: true,
    description: 'Invoice 22\nInvoice 23'
  }))

  // for pkg1, there was a 1000 donation from a user, which will be
  // attributed to Flossbank during redistribution, as well as 100 in
  // ad revenue
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: flossbankOrgId.toString(),
    amount: 1100000,
    timestamp: Date.now(),
    targetPackageId: pkgId1.toString(),
    redistributedDonation: true,
    description: 'User Dono\nAd revenue redistribution'
  }))

  // for pkg2, there was 200 in unprocessed donos from org2, and pkg2 has no deps,
  // so the message should not include the target package ID
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: orgId2.toString(),
    amount: 200000,
    timestamp: Date.now(),
    redistributedDonation: true,
    description: ''
  }))

  // for pkg2, there was 150 in ad revenue, which will be redistributed
  // from Flossbank org; and since pkg2 has no deps, the message should not
  // include the target package ID
  t.true(sqs.distributeOrgDonation.calledWith({
    organizationId: flossbankOrgId.toString(),
    amount: 150000,
    timestamp: Date.now(),
    redistributedDonation: true,
    description: 'Ad revenue redistribution'
  }))

  // nothing for pkg3, since all of its donations were already processed
  const allSqsMessages = sqs.distributeOrgDonation.getCalls()
  t.true(!allSqsMessages.some(({ firstArg: msg }) => msg.targetPackageId === pkgId3.toString()))

  // and nothing for pkg4, since it is not on the no-comp list
  t.true(!allSqsMessages.some(({ firstArg: msg }) => msg.targetPackageId === pkgId4.toString()))

  // and nothing for pkg5, since it has no donations or ads
  t.true(!allSqsMessages.some(({ firstArg: msg }) => msg.targetPackageId === pkgId5.toString()))
})
