const { MongoClient, ObjectId } = require('mongodb')

const MONGO_DB = 'flossbank_db'
const PACKAGES_COLLECTION = 'packages'
const META_COLLECTION = 'meta'
const NO_COMP = 'noCompList'

class Mongo {
  constructor ({ config, log }) {
    this.log = log
    this.config = config
    this.db = null
    this.mongoClient = null
  }

  async connect () {
    const mongoUri = await this.config.getMongoUri()
    this.mongoClient = new MongoClient(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    })
    await this.mongoClient.connect()

    this.db = this.mongoClient.db(MONGO_DB)
  }

  async close () {
    if (this.mongoClient) return this.mongoClient.close()
  }

  // 1. get all the no comp lists (one for each supported lang/reg)
  // 2. for each list, find packages that have outstanding revenue or are not marked as noComp
  // 3. combine them all into one list and return it
  async getNoCompPackages () {
    const noCompLists = await this.db.collection(META_COLLECTION).find({
      name: NO_COMP
    }).toArray()

    const pkgsWithRevenueByLangReg = await Promise.all(noCompLists.map(async ({ language, registry, list }) => {
      return this.db.collection(PACKAGES_COLLECTION).aggregate([
        { // matches all packages in the no-comp list `list` with the proper `language` and `registry`
          // that either have outstanding donation revenue, outstanding ad revenue, or are not already marked as noComp
          $match: {
            name: { $in: list },
            language,
            registry,
            $or: [
              {
                donationRevenue: {
                  $elemMatch: {
                    processed: { $ne: true }
                  }
                }
              },
              {
                adRevenue: {
                  $elemMatch: {
                    processed: { $ne: true }
                  }
                }
              },
              { noComp: { $ne: true } }
            ]
          }
        },
        {
          $project: {
            _id: 1,
            name: 1,
            language: 1,
            registry: 1,
            donationRevenue: {
              $filter: {
                input: '$donationRevenue',
                as: 'dono',
                cond: { $ne: ['$$dono.processed', true] }
              }
            },
            adRevenue: {
              $filter: {
                input: '$adRevenue',
                as: 'ad',
                cond: { $ne: ['$$ad.processed', true] }
              }
            }
          }
        }
      ]).toArray()
    }))

    // flatten
    const allPkgs = pkgsWithRevenueByLangReg.reduce((acc, pkgs) => acc.concat(pkgs), [])

    return allPkgs
  }

  // clears donation and ad revenues and tags the package
  async markPkgAsNoComp ({ packageId }) {
    return this.db.collection(PACKAGES_COLLECTION).updateOne({
      _id: ObjectId(packageId.toString())
    }, {
      $unset: {
        donationRevenue: true,
        adRevenue: true
      },
      $set: {
        noComp: true
      }
    })
  }
}

module.exports = Mongo
