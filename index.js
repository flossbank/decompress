const AWS = require('aws-sdk')
const Pino = require('pino')
const Process = require('./lib/process')
const Config = require('./lib/config')
const Db = require('./lib/mongo')
const Sqs = require('./lib/sqs')

const kms = new AWS.KMS({ region: 'us-west-2' })
const awsSqs = new AWS.SQS()

/*
 * Find all packages on the no-comp list that have outstanding revenue
 * For each of those packages, mark their donations as processed
 *   and send a message to the DistributeOrgDonations lambda with the
 *   total amount the package was owed by each organization that donated
*/
exports.handler = async () => {
  const log = Pino()
  const config = new Config({ kms })
  const db = new Db({ log, config })
  const sqs = new Sqs({ sqs: awsSqs, config })
  await db.connect()

  try {
    await Process.process({ db, log, sqs })
  } finally {
    await db.close()
  }
}
