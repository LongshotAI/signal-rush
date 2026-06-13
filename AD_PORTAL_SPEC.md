# Signal Rush Advertiser Portal Spec

## Objective
Create a web portal where advertising partners can onboard and manage campaigns without requiring manual operator intervention for every small action.

## MVP Features
### Partner account
- Sign up
- Log in
- Profile and billing details stub

### Campaign management
- Create campaign
- Define campaign name
- Upload creative assets
- Select placement type
- Set date range
- Set budget
- Pause/resume

### Reporting
- Impressions
- Spend pacing
- Active/inactive status
- Basic CTR if applicable

## Placement Types
- Passive HUD frame
- Interstitial between runs

## Safety and Review
- Manual approval workflow for creatives
- Brand safety rules
- Content rejection reasons
- Partner approval queue

## MVP Non-Goals
- Advanced targeting
- Real-time auction bidding
- Complex attribution
- Self-serve payouts beyond simple invoicing flow

## UX Priorities
- Fast onboarding
- Clear placement descriptions
- No ad-tech jargon overload
- Transparent campaign state

## Required Backend Capabilities
- Auth
- Campaign CRUD
- Creative upload storage
- Approval state machine
- Impression logging
- Dashboard aggregation
