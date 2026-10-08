// Problem bank. `prompt` is shown to the candidate; `notes` go only to the interviewer model.
window.PROBLEMS = [
  {
    id: 'dedup-aggregate',
    title: 'Deduplicate and aggregate conversion events',
    prompt:
      'Conversion events arrive from advertisers, sometimes more than once (a browser pixel and a server can both report the same purchase).\n\n' +
      'Build a class that ingests events shaped like {"id", "campaign_id", "ts"} and can report how many unique conversions a campaign had in a given minute. ' +
      'Memory must not grow without bound.',
    starter:
      'class ConversionAggregator:\n' +
      '    def __init__(self, dedup_ttl_secs, bucket_secs=60):\n' +
      '        pass\n\n' +
      '    def ingest(self, event: dict, now: float) -> bool:\n' +
      '        """Returns False if the event is a duplicate."""\n' +
      '        pass\n\n' +
      '    def count(self, campaign_id: str, bucket_start: int) -> int:\n' +
      '        pass\n\n\n' +
      'agg = ConversionAggregator(dedup_ttl_secs=3600)\n' +
      'print(agg.ingest({"id": "e1", "campaign_id": "c1", "ts": 125}, now=130))\n',
    notes:
      'Good solution: a hash map of seen event ids with arrival time, kept in insertion order (OrderedDict, or a set plus a deque) so the oldest ids can be expired cheaply; ' +
      'counts keyed by (campaign_id, ts rounded down to the bucket). Dedup must key on the event id, not the campaign id. ' +
      'Bucket by event time, expire by arrival time. ' +
      'Follow-ups: what happens to a duplicate that arrives after the TTL (batch reconciliation); two advertisers reusing the same event id (key on advertiser plus id); ' +
      'late and out-of-order events; running this across many machines (partition by key, shared or keyed state); memory cost and Bloom filters; input validation.',
  },
  {
    id: 'attribution',
    title: 'Last-touch attribution',
    prompt:
      'You receive ad impressions (user, campaign, timestamp) and later conversions (user, timestamp).\n\n' +
      'Build a class that attributes each conversion to the campaign of that user\'s most recent impression before the conversion, ' +
      'as long as it happened within a lookback window. Return None when nothing qualifies.',
    starter:
      'class Attributor:\n' +
      '    def __init__(self, lookback_secs):\n' +
      '        pass\n\n' +
      '    def record_impression(self, user_id: str, campaign_id: str, ts: float) -> None:\n' +
      '        pass\n\n' +
      '    def attribute(self, user_id: str, conversion_ts: float):\n' +
      '        """Returns a campaign_id or None."""\n' +
      '        pass\n\n\n' +
      'a = Attributor(lookback_secs=7 * 24 * 3600)\n' +
      'a.record_impression("u1", "c1", ts=100)\n' +
      'print(a.attribute("u1", conversion_ts=500))\n',
    notes:
      'Good solution: per-user list of (ts, campaign) kept sorted by time; find the last impression at or before the conversion time (linear scan from the end is fine, binary search is better), ' +
      'then check the lookback window. Edge cases: no impressions, impression after the conversion, impression exactly at the window boundary. ' +
      'Follow-ups: impressions arriving out of order; a conversion processed before its impression arrives; evicting impressions older than the lookback; ' +
      'first-touch or multi-touch models; the conversion carrying a hashed email while the impression carries a member id (identity resolution); state size at scale.',
  },
  {
    id: 'rate-limiter',
    title: 'Per-advertiser rate limiter',
    prompt:
      'The Conversion API must stop any single advertiser from overwhelming it.\n\n' +
      'Build a rate limiter where each advertiser may send a sustained number of requests per second, with a limited burst allowance. ' +
      'allow(advertiser_id, now) returns True if the request may proceed.',
    starter:
      'class RateLimiter:\n' +
      '    def __init__(self, rate_per_sec: float, burst: float):\n' +
      '        pass\n\n' +
      '    def allow(self, advertiser_id: str, now: float) -> bool:\n' +
      '        pass\n\n\n' +
      'rl = RateLimiter(rate_per_sec=2, burst=5)\n' +
      'print([rl.allow("adv1", now=0) for _ in range(6)])\n',
    notes:
      'Good solution: a token bucket per advertiser, refilled lazily from elapsed time and capped at the burst size. A sliding-window log or counter is also acceptable if they explain the trade-off. ' +
      'Check: tokens are capped, elapsed time cannot go negative, each advertiser is independent. ' +
      'Follow-ups: memory for idle advertisers (evict them); thread safety; different limits per advertiser; many API servers sharing one limit (central store, or local slices); ' +
      'what to return to the caller (HTTP 429 with retry-after); token bucket compared with sliding window.',
  },
  {
    id: 'batch-validate',
    title: 'Validate and normalize a batch upload',
    prompt:
      'Advertisers upload batches of conversion events as a list of dicts. Each event needs: event_id (non-empty string), event_time (unix seconds, not in the future, at most 7 days old), ' +
      'event_name (one of purchase, add_to_cart, sign_up) and email.\n\n' +
      'Write process_batch(events, now) that returns the valid events, normalized (email trimmed, lowercased and SHA-256 hashed), plus a list of per-row errors. One bad row must not fail the batch.',
    starter:
      'import hashlib\n\n' +
      'ALLOWED_EVENTS = {"purchase", "add_to_cart", "sign_up"}\n' +
      'MAX_AGE_SECS = 7 * 24 * 3600\n\n\n' +
      'def process_batch(events: list, now: float):\n' +
      '    """Returns (valid_events, errors). Each error is {"row": index, "reason": str}."""\n' +
      '    pass\n\n\n' +
      'batch = [\n' +
      '    {"event_id": "e1", "event_time": 1000, "event_name": "purchase", "email": " Jane@Example.com "},\n' +
      '    {"event_id": "", "event_time": 1000, "event_name": "purchase", "email": "a@b.com"},\n' +
      ']\n' +
      'print(process_batch(batch, now=2000))\n',
    notes:
      'Good solution: loop with the row index, validate each field, collect errors without raising, normalize the email before hashing, and never keep or print the raw email. ' +
      'Watch for: missing keys (use get), wrong types, event_time as a string, duplicate event_ids inside one batch. ' +
      'Follow-ups: reporting several errors for one row; duplicates within the batch; files too large for memory (streaming, chunking); consent flags and dropping events without consent; ' +
      'why normalize before hashing; idempotent re-upload of the same file; what the API response should look like.',
  },
  {
    id: 'frequency-capper',
    title: 'Frequency capper',
    prompt:
      'A member should not see the same campaign more than N times in any rolling time window.\n\n' +
      'Build a class with can_serve(user_id, campaign_id, now) and record(user_id, campaign_id, now).',
    starter:
      'class FrequencyCapper:\n' +
      '    def __init__(self, max_impressions: int, window_secs: float):\n' +
      '        pass\n\n' +
      '    def can_serve(self, user_id: str, campaign_id: str, now: float) -> bool:\n' +
      '        pass\n\n' +
      '    def record(self, user_id: str, campaign_id: str, now: float) -> None:\n' +
      '        pass\n\n\n' +
      'fc = FrequencyCapper(max_impressions=2, window_secs=10)\n' +
      'print(fc.can_serve("u1", "c1", now=0))\n',
    notes:
      'Good solution: a deque of timestamps per (user, campaign); evict from the left while the oldest is outside the window; compare the length with the cap. ' +
      'Ask about the window boundary (is an impression exactly window_secs old still counted). ' +
      'Follow-ups: memory at scale (time buckets with counters); the race between can_serve and record (one atomic call); distributed version (Redis sorted sets or counters with TTL); ' +
      'why pass now in instead of reading the clock.',
  },
  {
    id: 'lru-ttl',
    title: 'LRU cache with TTL',
    prompt:
      'Identity lookups are expensive, so they are cached.\n\n' +
      'Build a cache with a fixed capacity that evicts the least recently used entry when full, and where every entry also expires a fixed time after it was written.',
    starter:
      'class LRUCacheTTL:\n' +
      '    def __init__(self, capacity: int, ttl_secs: float):\n' +
      '        pass\n\n' +
      '    def get(self, key, now: float):\n' +
      '        """Returns the value, or None if missing or expired."""\n' +
      '        pass\n\n' +
      '    def put(self, key, value, now: float) -> None:\n' +
      '        pass\n\n\n' +
      'c = LRUCacheTTL(capacity=2, ttl_secs=10)\n' +
      'c.put("a", 1, now=0)\n' +
      'print(c.get("a", now=5))\n',
    notes:
      'Good solution: OrderedDict of key to (value, expires_at); get checks expiry, deletes if expired, otherwise moves the key to the end; put writes, moves to the end and evicts from the front when over capacity. ' +
      'Follow-ups: implement it without OrderedDict (dict plus doubly linked list); lazy versus active expiry (heap of expiry times, background sweeper); ' +
      'why lazy expiry is not enough when the TTL is a privacy retention rule; thread safety.',
  },
  {
    id: 'ad-selection',
    title: 'Ad selection with a second-price auction',
    prompt:
      'Given candidate ads, each with a bid and targeting rules (attribute to allowed values), and a user described by attributes:\n\n' +
      'Pick the eligible ad with the highest bid. The winner pays the second-highest eligible bid, or a floor price if it is the only eligible ad.',
    starter:
      'class AdSelector:\n' +
      '    def __init__(self, floor=0.0):\n' +
      '        pass\n\n' +
      '    def add_ad(self, ad_id, bid, targeting=None):\n' +
      '        pass\n\n' +
      '    def select(self, user: dict):\n' +
      '        """Returns (ad, price) or None."""\n' +
      '        pass\n\n\n' +
      's = AdSelector(floor=1.0)\n' +
      's.add_ad("a1", 5.0, {"country": ["US", "CA"]})\n' +
      'print(s.select({"country": "US"}))\n',
    notes:
      'Good solution: filter by eligibility (every targeting rule matches, bid at or above the floor), then one pass tracking the best and second-best bids; no need to sort. ' +
      'Edge cases: no eligible ads, one eligible ad, ties, user missing an attribute, empty targeting. ' +
      'Follow-ups: complexity versus sorting; millions of ads (inverted index on targeting); why second price; adding frequency caps or pacing as eligibility checks.',
  },
  {
    id: 'design-conversion-api',
    title: 'System design: Conversion API',
    design: true,
    prompt:
      'Design an API that lets advertisers send conversion events (purchases, sign-ups) to the ads platform in near real time, ' +
      'by server-to-server calls, a browser pixel, and batch file uploads. The output feeds measurement, optimization, retargeting and reporting.\n\n' +
      'Use the editor for notes. There is no code to run.',
    starter:
      '# Notes\n\n# Requirements\n\n\n# API\n\n\n# Architecture\n\n\n# Deep dives\n\n',
    notes:
      'This is a design discussion, not coding. The editor holds the candidate\'s notes. ' +
      'Expect: clarifying questions (sources, consumers, scale, latency, correctness); API shape and event schema with an advertiser-supplied event id; ' +
      'a thin ingestion service that validates and writes to a durable log before acknowledging; asynchronous stream processing for consent filtering, deduplication, identity resolution and attribution; raw events kept for replay. ' +
      'Push on one or two areas in depth: deduplicating pixel and server copies and the dedup window; late and out-of-order events; identity matching on hashed identifiers; ' +
      'privacy, consent, retention and deletion requests; per-advertiser rate limits and hot partitions; at-least-once delivery with idempotent processing; monitoring and match rate. ' +
      'A strong candidate raises privacy unprompted, states assumptions with numbers, and names trade-offs.',
  },
  {
    id: 'custom',
    title: 'Custom (describe your own)',
    custom: true,
    prompt: '',
    starter: '',
    notes: 'The candidate supplied this problem themselves. Work out a reasonable solution and follow-ups on your own.',
  },
];
