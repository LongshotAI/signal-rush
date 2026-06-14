const SPONSOR_CONTENT = {
  rotatingShellLabels: [
    'Presented by Temple Works',
    'Supported by Ugly Sweater Party',
    'Sponsor Impression Active',
  ],
  interstitials: [
    {
      title: 'Sponsor Card',
      body: 'This game session is sponsored. Strong play quality drives stronger partner value.',
    },
    {
      title: 'Partner Surface',
      body: 'Terminal sponsorship should feel premium, visible, and non-intrusive to the run itself.',
    },
  ],
  // Partner-facing value props used by the in-frame sponsor card. These
  // give advertisers a clear "why this format" pitch the next time we
  // talk to a brand about the placement.
  partnerPitches: {
    templeWorks: 'Long-form, narrative-driven product work — building the surface signal-rush runs on.',
    uglySweaterParty: 'Community-first indie brand — high attention, low-friction placement for short sessions.',
  },
};

module.exports = {
  SPONSOR_CONTENT,
};
