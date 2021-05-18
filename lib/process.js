exports.process = async ({ log, db, sqs }) => {
  log.info('Looking for packages on the no-comp list that have outstanding revenue')

  const packages = await db.getNoCompPackagesWithUnprocessedDonations()
  log.info({ packagesToProcess: packages.length })

  for (const pkg of packages) {
    const orgToCombinedDonation = new Map()

    const { donationRevenue } = pkg

    // sum all the donations from each org that has donated
    for (const dono of (donationRevenue || [])) {
      const { amount = 0, combinedDescription = [] } = orgToCombinedDonation.get(dono.organizationId) || {}
      orgToCombinedDonation.set(dono.organizationId, {
        amount: amount + dono.amount,
        combinedDescription: dono.description ? combinedDescription.concat(dono.description) : combinedDescription
      })
    }

    // send a message to DOD targeting this package with the combined donations from each org
    const sqsMsgs = [...orgToCombinedDonation.entries()].map(async ([orgId, { amount, combinedDescription }]) => {
      log.info(`Redistributing ${amount} from org ${orgId} for pkg ${pkg._id}`)
      return sqs.distributeOrgDonation({
        organizationId: orgId,
        amount,
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
