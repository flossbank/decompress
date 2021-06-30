# decompress
a scheduled lambda that finds packages that are on the no-comp list (meta.noComp) that match one of the following:
- outstanding revenue (ads or donations)
- the noComp flag is not on the package document

with the resulting packages, it will queue Distribute Org Donations to redistribute the revenue, and it will mark all the packages with noComp:true.
