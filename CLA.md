# Restow Contributor License Agreement

Version 1.0

This agreement is between you ("You") and IT Systeme Flores UG
(haftungsbeschränkt), Bergisch Gladbach, Germany, Amtsgericht Köln
HRB 111656 ("the Maintainer"; full contact details:
https://restowbackup.com/en/imprint/), and applies to every contribution You
submit to the Restow project.

## Why this exists

Restow is Open Core: the core, everything outside `ee/`, is licensed under
the Apache License 2.0, the Business and Service Provider modules in `ee/`
are source-available under their own license (`ee/LICENSE`, the Restow
license terms), and both ship in one repository and in the full release
images. A contribution may become part of the core or of `ee/`, so the
Maintainer needs the right to license contributions under more than one
license. You keep the copyright in your work.

## 1. Definitions

**Contribution** means any work of authorship, including code,
documentation and translations, that You intentionally submit to the
Maintainer for inclusion in Restow, for example as a pull request, a patch
or an issue attachment.

## 2. Copyright license

You grant the Maintainer and recipients of software distributed by the
Maintainer a perpetual, worldwide, non-exclusive, free of charge,
irrevocable copyright license to reproduce, prepare derivative works of,
publicly display, publicly perform, sublicense and distribute Your
Contributions and such derivative works, under the Apache License 2.0,
under the license in `ee/LICENSE`, or under any other license, including
proprietary ones.

## 3. Patent license

You grant the Maintainer and recipients of software distributed by the
Maintainer a perpetual, worldwide, non-exclusive, free of charge,
irrevocable patent license to make, have made, use, sell, offer for sale,
import and otherwise transfer Your Contributions, for patent claims You can
license that are necessarily infringed by Your Contribution alone or by its
combination with Restow.

## 4. Commitment

The Maintainer commits that every Contribution to a file outside `ee/`
stays available under the Apache License 2.0 in the public repository.

## 5. Your representations

You represent that:

1. each Contribution is Your original work, or You have the right to submit
   it under this agreement, and You identify any third-party parts and
   their licenses in the submission;
2. if Your employer has rights in Your Contributions, You have permission to
   make them on its behalf, or Your employer has waived those rights;
3. You are not aware of any claim, license or other restriction that
   conflicts with this agreement.

## 6. No obligation, no warranty

The Maintainer is not obliged to use any Contribution. You provide
Contributions "as is", without warranty of any kind, except as stated in
section 5.

## 7. Law

This agreement is governed by the laws of the Federal Republic of Germany,
excluding the UN Convention on Contracts for the International Sale of
Goods.

## How to agree

When you open your first pull request, the CLA check asks you to agree by
commenting on the pull request with exactly this sentence:

> I have read the Restow Contributor License Agreement, version 1.0, and I
> agree to it for all my present and future contributions to Restow.

The check records your GitHub account, the pull request and the date in the
`cla-signatures` branch of the repository. You agree once; it covers all
your later contributions. If you contribute for your employer, make sure
point 2 of section 5 is covered before you comment.

Every commit additionally carries a Developer Certificate of Origin sign-off
(`git commit -s`), see CONTRIBUTING.md.
