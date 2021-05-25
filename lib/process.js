exports.process = async ({ log, db, sqs, config, resolver }) => {
  log.info('Looking for packages on the no-comp list that have outstanding revenue')

  const packages = await db.getNoCompPackagesWithUnprocessedDonations()
  log.info({ packagesToProcess: packages.length })

  const packagesWithNoDeps = new Set((await Promise.all(
    packages.map(async ({ name, registry, language, ...rest }) => {
      // we don't need to check if pkgReg is falsey, because the only way packages
      // end up in our database is through the supported registrys of registry-resolver
      const pkgReg = resolver.getSupportedRegistry({ language, registry })

      const pkgSpec = pkgReg.getSpec(pkgReg.buildLatestSpec(name))
      const deps = await pkgReg.getDependencies(pkgSpec)
      return { name, registry, language, ...rest, depCount: deps.length }
    })
  )).filter(({ depCount }) => depCount === 0).map(({ _id }) => _id.toString()))

  const flossbankOrgId = config.getFlossbankOrgId()

  for (const pkg of packages) {
    const orgToCombinedDonation = new Map()

    const { donationRevenue, adRevenue } = pkg

    // sum all the donations from each org that has donated
    // user donations are attributed to the Flossbank org during redistribution
    for (const dono of (donationRevenue || [])) {
      const organizationId = dono.organizationId || flossbankOrgId

      const { amount = 0, combinedDescription = [] } = orgToCombinedDonation.get(organizationId) || {}
      orgToCombinedDonation.set(organizationId, {
        amount: amount + dono.amount,
        combinedDescription: dono.description ? combinedDescription.concat(dono.description) : combinedDescription
      })
    }

    // ad revenue is attributed to the FLossbank org as well
    const totalAdRevenue = (adRevenue || []).reduce((sum, ad) => sum + ad.amount, 0)
    if (totalAdRevenue > 0) {
      const { amount = 0, combinedDescription = [] } = orgToCombinedDonation.get(flossbankOrgId) || {}
      orgToCombinedDonation.set(flossbankOrgId, {
        amount: amount + totalAdRevenue,
        combinedDescription: combinedDescription.concat('Ad revenue redistribution')
      })
    }

    // send a message to DOD targeting this package with the combined donations from each org
    // distribute-org-donations takes as input cents; we store donations and ads as millicents;
    // so in the messages below, we divide our millicents by 1000 to get cents again
    const sqsMsgs = [...orgToCombinedDonation.entries()].map(async ([orgId, { amount, combinedDescription }]) => {
      log.info(`Redistributing ${amount} from org ${orgId} for pkg ${pkg._id}`)

      // if the package has no deps, we can't redistribute its revenue to its deps;
      // instead, we redistribute it to the org's full dep tree
      if (packagesWithNoDeps.has(pkg._id.toString())) {
        return sqs.distributeOrgDonation({
          organizationId: orgId,
          amount: amount / 1000,
          timestamp: Date.now(),
          redistributedDonation: true,
          description: combinedDescription.join('\n')
        })
      }

      return sqs.distributeOrgDonation({
        organizationId: orgId,
        amount: amount / 1000,
        timestamp: Date.now(),
        targetPackageId: pkg._id.toString(),
        redistributedDonation: true,
        description: combinedDescription.join('\n')
      })
    })

    await Promise.all(sqsMsgs)

    // mark all ad and donation revenue as processed
    await db.markAllIncomeAsProcessed({ packageId: pkg._id })
  }

  return { success: true }
}
