// Assert tests per problem, run by the "Run tests" button after the candidate's code.
// Each test is a function named test_*; every assert carries a message that explains the expectation.
const TESTS = {
  'dedup-aggregate': `
def _event(event_id, ts, campaign="c1"):
    return {"id": event_id, "campaign_id": campaign, "ts": ts}

def test_new_event_is_counted():
    agg = ConversionAggregator(dedup_ttl_secs=3600)
    assert agg.ingest(_event("e1", 125), now=130) is True, "a new event should return True"
    assert agg.count("c1", 120) == 1, "ts 125 belongs to the bucket that starts at 120"

def test_duplicate_is_rejected():
    agg = ConversionAggregator(dedup_ttl_secs=3600)
    agg.ingest(_event("e1", 125), now=130)
    assert agg.ingest(_event("e1", 125), now=140) is False, "the same id again should return False"
    assert agg.count("c1", 120) == 1, "a duplicate must not be counted"

def test_different_events_for_one_campaign_both_count():
    agg = ConversionAggregator(dedup_ttl_secs=3600)
    assert agg.ingest(_event("e1", 125), now=130) is True
    assert agg.ingest(_event("e2", 170), now=171) is True, "a different event id for the same campaign is not a duplicate"
    assert agg.count("c1", 120) == 2, "both events fall in the bucket that starts at 120"

def test_late_event_goes_to_its_own_bucket():
    agg = ConversionAggregator(dedup_ttl_secs=3600)
    agg.ingest(_event("e1", 125), now=130)
    agg.ingest(_event("e2", 110), now=200)
    assert agg.count("c1", 60) == 1, "an event with ts 110 belongs to the bucket that starts at 60, even if it arrives late"
    assert agg.count("c1", 120) == 1, "the late event must not be added to the newer bucket"

def test_campaigns_are_counted_separately():
    agg = ConversionAggregator(dedup_ttl_secs=3600)
    agg.ingest(_event("e1", 125, campaign="c1"), now=130)
    agg.ingest(_event("e2", 125, campaign="c2"), now=131)
    assert agg.count("c1", 120) == 1, "c1 should have one conversion"
    assert agg.count("c2", 120) == 1, "c2 should have one conversion"

def test_unknown_campaign_or_bucket_is_zero():
    agg = ConversionAggregator(dedup_ttl_secs=3600)
    assert agg.count("nobody", 0) == 0, "count should be 0 when nothing was ingested"

def test_custom_bucket_size():
    agg = ConversionAggregator(dedup_ttl_secs=3600, bucket_secs=300)
    agg.ingest(_event("e1", 610), now=611)
    assert agg.count("c1", 600) == 1, "with 300-second buckets, ts 610 belongs to the bucket that starts at 600"

def test_ids_are_forgotten_after_the_ttl():
    agg = ConversionAggregator(dedup_ttl_secs=100)
    agg.ingest(_event("e1", 0), now=0)
    assert agg.ingest(_event("e1", 0), now=50) is False, "inside the TTL the id is still remembered"
    assert agg.ingest(_event("e1", 0), now=500) is True, "after the TTL the id should have been dropped, or memory grows forever"
`,

  attribution: `
def test_conversion_is_attributed():
    a = Attributor(lookback_secs=1000)
    a.record_impression("u1", "c1", ts=100)
    assert a.attribute("u1", conversion_ts=500) == "c1", "the only impression before the conversion should get the credit"

def test_no_impressions_gives_none():
    a = Attributor(lookback_secs=1000)
    assert a.attribute("u1", conversion_ts=500) is None, "a user with no impressions cannot be attributed"

def test_most_recent_impression_wins():
    a = Attributor(lookback_secs=1000)
    a.record_impression("u1", "c1", ts=100)
    a.record_impression("u1", "c2", ts=200)
    assert a.attribute("u1", conversion_ts=500) == "c2", "last-touch means the latest impression before the conversion"

def test_impressions_after_the_conversion_are_ignored():
    a = Attributor(lookback_secs=1000)
    a.record_impression("u1", "c1", ts=100)
    a.record_impression("u1", "c2", ts=600)
    assert a.attribute("u1", conversion_ts=500) == "c1", "an impression at 600 cannot explain a conversion at 500"

def test_only_a_later_impression_gives_none():
    a = Attributor(lookback_secs=1000)
    a.record_impression("u1", "c1", ts=600)
    assert a.attribute("u1", conversion_ts=500) is None, "the only impression happened after the conversion"

def test_impression_outside_the_lookback_gives_none():
    a = Attributor(lookback_secs=100)
    a.record_impression("u1", "c1", ts=100)
    assert a.attribute("u1", conversion_ts=500) is None, "an impression 400 seconds earlier is outside a 100-second lookback"

def test_recent_impression_inside_the_lookback():
    a = Attributor(lookback_secs=100)
    a.record_impression("u1", "c1", ts=100)
    a.record_impression("u1", "c2", ts=450)
    assert a.attribute("u1", conversion_ts=500) == "c2", "the impression 50 seconds earlier is inside the lookback"

def test_users_are_separate():
    a = Attributor(lookback_secs=1000)
    a.record_impression("u1", "c1", ts=100)
    assert a.attribute("u2", conversion_ts=500) is None, "another user's impression must not be used"
`,

  'rate-limiter': `
def _drain(rl, advertiser, now, n):
    return [rl.allow(advertiser, now=now) for _ in range(n)]

def test_burst_is_allowed_then_blocked():
    rl = RateLimiter(rate_per_sec=2, burst=5)
    results = _drain(rl, "a", 0, 6)
    assert results == [True] * 5 + [False], f"expected 5 allowed then 1 blocked, got {results}"

def test_tokens_refill_over_time():
    rl = RateLimiter(rate_per_sec=2, burst=5)
    _drain(rl, "a", 0, 5)
    assert rl.allow("a", now=0) is False, "the burst is used up"
    assert rl.allow("a", now=0.5) is True, "half a second at 2 per second refills one request"
    assert rl.allow("a", now=0.5) is False, "only one request was refilled"

def test_refill_is_capped_at_the_burst():
    rl = RateLimiter(rate_per_sec=2, burst=5)
    _drain(rl, "a", 0, 5)
    results = _drain(rl, "a", 1000, 6)
    assert results == [True] * 5 + [False], f"after a long idle period only the burst size should be available, got {results}"

def test_advertisers_are_independent():
    rl = RateLimiter(rate_per_sec=2, burst=5)
    _drain(rl, "a", 0, 5)
    assert rl.allow("a", now=0) is False, "advertiser a is out of requests"
    assert rl.allow("b", now=0) is True, "advertiser b has its own allowance"

def test_sustained_rate_is_enforced():
    rl = RateLimiter(rate_per_sec=1, burst=1)
    allowed = sum(rl.allow("a", now=i * 0.25) for i in range(40))
    assert 9 <= allowed <= 11, f"4 requests per second for 10 seconds at 1 per second should allow about 10, got {allowed}"
`,

  'batch-validate': `
import hashlib as _hashlib

def _sha(text):
    return _hashlib.sha256(text.encode()).hexdigest()

def _event(**overrides):
    event = {"event_id": "e1", "event_time": 1000, "event_name": "purchase", "email": "jane@example.com"}
    event.update(overrides)
    return event

def _only_error(events, now=2000):
    valid, errors = process_batch(events, now=now)
    assert valid == [], f"the event should have been rejected, but valid was {valid}"
    assert len(errors) == 1, f"expected exactly one error, got {errors}"
    return errors[0]

def test_valid_event_passes():
    valid, errors = process_batch([_event()], now=2000)
    assert len(valid) == 1, f"a well-formed event should be accepted, got {valid}"
    assert errors == [], f"a well-formed event should produce no errors, got {errors}"

def test_email_is_normalized_then_hashed():
    valid, _ = process_batch([_event(email="  Jane@Example.COM ")], now=2000)
    assert valid[0]["email"] == _sha("jane@example.com"), "the email field should hold the SHA-256 hex digest of the trimmed, lowercased address"

def test_raw_email_is_not_kept():
    valid, _ = process_batch([_event(email="Jane@Example.com")], now=2000)
    assert "jane@example.com" not in str(valid[0]).lower(), "the raw email address must not appear anywhere in the output"

def test_empty_event_id_is_rejected():
    error = _only_error([_event(event_id="")])
    assert error["row"] == 0, "the error should name row 0"

def test_missing_field_is_reported_not_raised():
    event = _event()
    del event["email"]
    error = _only_error([event])
    assert error["row"] == 0, "the error should name row 0"

def test_unknown_event_name_is_rejected():
    _only_error([_event(event_name="page_view")])

def test_future_event_is_rejected():
    _only_error([_event(event_time=3000)], now=2000)

def test_event_older_than_seven_days_is_rejected():
    _only_error([_event(event_time=1000)], now=1000 + 8 * 24 * 3600)

def test_error_has_a_reason():
    error = _only_error([_event(event_id="")])
    assert isinstance(error.get("reason"), str) and error["reason"], "each error needs a non-empty reason string"

def test_one_bad_row_does_not_fail_the_batch():
    batch = [_event(event_id="a"), _event(event_id=""), _event(event_id="c")]
    valid, errors = process_batch(batch, now=2000)
    assert [e["event_id"] for e in valid] == ["a", "c"], f"rows 0 and 2 are valid and should be returned in order, got {valid}"
    assert [e["row"] for e in errors] == [1], f"only row 1 is bad, got {errors}"
`,

  'frequency-capper': `
def test_serves_when_under_the_cap():
    fc = FrequencyCapper(max_impressions=2, window_secs=10)
    assert fc.can_serve("u1", "c1", now=0) is True, "nothing has been shown yet"

def test_blocks_at_the_cap():
    fc = FrequencyCapper(max_impressions=2, window_secs=10)
    fc.record("u1", "c1", now=0)
    assert fc.can_serve("u1", "c1", now=1) is True, "one impression is still under a cap of 2"
    fc.record("u1", "c1", now=1)
    assert fc.can_serve("u1", "c1", now=5) is False, "two impressions inside the window reaches the cap"

def test_window_slides():
    fc = FrequencyCapper(max_impressions=2, window_secs=10)
    fc.record("u1", "c1", now=0)
    fc.record("u1", "c1", now=1)
    assert fc.can_serve("u1", "c1", now=9) is False, "both impressions are still inside the window at t=9"
    assert fc.can_serve("u1", "c1", now=10.5) is True, "the impression from t=0 has left the window by t=10.5"

def test_can_serve_does_not_record():
    fc = FrequencyCapper(max_impressions=2, window_secs=10)
    for _ in range(5):
        fc.can_serve("u1", "c1", now=0)
    assert fc.can_serve("u1", "c1", now=0) is True, "checking must not count as an impression"

def test_users_and_campaigns_are_separate():
    fc = FrequencyCapper(max_impressions=2, window_secs=10)
    fc.record("u1", "c1", now=0)
    fc.record("u1", "c1", now=1)
    assert fc.can_serve("u2", "c1", now=2) is True, "another user has their own count"
    assert fc.can_serve("u1", "c2", now=2) is True, "another campaign has its own count"
`,

  'lru-ttl': `
def test_get_returns_what_was_put():
    c = LRUCacheTTL(capacity=2, ttl_secs=10)
    c.put("a", 1, now=0)
    assert c.get("a", now=5) == 1, "a fresh entry should be returned"

def test_missing_key_gives_none():
    c = LRUCacheTTL(capacity=2, ttl_secs=10)
    assert c.get("missing", now=0) is None, "a key that was never put should give None"

def test_entry_expires_after_the_ttl():
    c = LRUCacheTTL(capacity=2, ttl_secs=10)
    c.put("a", 1, now=0)
    assert c.get("a", now=11) is None, "an entry written at t=0 with a 10-second TTL is gone by t=11"

def test_least_recently_used_is_evicted():
    c = LRUCacheTTL(capacity=2, ttl_secs=100)
    c.put("a", 1, now=0)
    c.put("b", 2, now=1)
    c.get("a", now=2)
    c.put("c", 3, now=3)
    assert c.get("b", now=4) is None, "b was the least recently used, so it should have been evicted"
    assert c.get("a", now=4) == 1, "a was read recently, so it should survive"
    assert c.get("c", now=4) == 3, "c was just written"

def test_overwrite_updates_the_value_without_evicting():
    c = LRUCacheTTL(capacity=2, ttl_secs=100)
    c.put("a", 1, now=0)
    c.put("b", 2, now=1)
    c.put("a", 10, now=2)
    assert c.get("a", now=3) == 10, "writing an existing key should replace its value"
    assert c.get("b", now=3) == 2, "rewriting an existing key must not evict another entry"

def test_overwrite_restarts_the_ttl():
    c = LRUCacheTTL(capacity=2, ttl_secs=10)
    c.put("a", 1, now=0)
    c.put("a", 2, now=8)
    assert c.get("a", now=15) == 2, "the entry was rewritten at t=8, so it lives until t=18"

def test_reading_does_not_extend_the_ttl():
    c = LRUCacheTTL(capacity=2, ttl_secs=10)
    c.put("a", 1, now=0)
    c.get("a", now=8)
    assert c.get("a", now=11) is None, "expiry is counted from the write, not from the last read"
`,

  'ad-selection': `
def _id(ad):
    # accept an id, a dict, or an object as the returned ad
    if isinstance(ad, dict):
        return ad.get("id", ad.get("ad_id"))
    return getattr(ad, "ad_id", getattr(ad, "id", ad))

def _selector():
    s = AdSelector(floor=1.0)
    s.add_ad("a1", 5.0, {"country": ["US", "CA"]})
    s.add_ad("a2", 8.0, {"country": ["US"], "device": ["tv"]})
    s.add_ad("a3", 9.0, {"country": ["UK"]})
    s.add_ad("a4", 3.0)
    s.add_ad("a5", 0.5)
    return s

def test_highest_eligible_bid_wins_and_pays_second_price():
    ad, price = _selector().select({"country": "US", "device": "tv"})
    assert _id(ad) == "a2", f"a3 bids most but targets the UK, so a2 should win, got {_id(ad)}"
    assert price == 5.0, f"the winner pays the next eligible bid (a1 at 5.0), got {price}"

def test_every_targeting_rule_must_match():
    ad, price = _selector().select({"country": "US", "device": "mobile"})
    assert _id(ad) == "a1", f"a2 needs a tv, so a1 should win on mobile, got {_id(ad)}"
    assert price == 3.0, f"the next eligible bid is a4 at 3.0, got {price}"

def test_single_eligible_ad_pays_the_floor():
    ad, price = _selector().select({"country": "FR"})
    assert _id(ad) == "a4", f"only the untargeted a4 is eligible in FR, got {_id(ad)}"
    assert price == 1.0, f"with no runner-up the winner pays the floor, got {price}"

def test_no_ads_gives_none():
    assert AdSelector().select({"country": "US"}) is None, "an empty selector has nothing to return"

def test_no_eligible_ad_gives_none():
    s = AdSelector()
    s.add_ad("a1", 5.0, {"country": ["US"]})
    assert s.select({"country": "FR"}) is None, "the only ad does not target this user"

def test_missing_user_attribute_is_not_a_match():
    s = AdSelector()
    s.add_ad("a1", 5.0, {"country": ["US"]})
    assert s.select({}) is None, "a user with no country cannot match a country rule"

def test_bid_below_the_floor_never_wins():
    s = AdSelector(floor=1.0)
    s.add_ad("a5", 0.5)
    assert s.select({"country": "US"}) is None, "a bid under the floor is not eligible"
`,
};

for (const p of window.PROBLEMS) p.tests = (TESTS[p.id] || '').trim();

// Appended after the tests: runs every test_* function and prints one line per test.
window.TEST_RUNNER = `
def _run_tests():
    tests = [(name, fn) for name, fn in list(globals().items()) if name.startswith("test_") and callable(fn)]
    passed = 0
    print("--- Tests ---")
    for name, fn in tests:
        try:
            fn()
        except AssertionError as err:
            print(f"FAIL  {name}: {err if str(err) else 'assertion failed'}")
        except Exception as err:
            print(f"ERROR {name}: {type(err).__name__}: {err}")
        else:
            passed += 1
            print(f"PASS  {name}")
    print()
    print(f"{passed} of {len(tests)} tests passed")

_run_tests()
`;
