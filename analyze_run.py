"""Analyze cestdone orchestrator run from log file.

Usage: python analyze_run.py <log-file>
"""
import re
import sys
from datetime import datetime, timedelta
from collections import defaultdict

if len(sys.argv) < 2:
    print("Usage: python analyze_run.py <log-file>")
    sys.exit(1)

LOG_PATH = sys.argv[1]

with open(LOG_PATH, encoding="utf-8") as f:
    lines = f.readlines()

# --- Parse timestamps ---
ts_pattern = re.compile(r"\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]")

def parse_ts(line):
    m = ts_pattern.search(line)
    if m:
        return datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
    return None

first_ts = parse_ts(lines[0])
last_ts = parse_ts(lines[-1])
total_duration = (last_ts - first_ts).total_seconds()

print("=" * 70)
print("CESTDONE ORCHESTRATOR RUN ANALYSIS")
print("=" * 70)
print(f"Start:    {first_ts.strftime('%H:%M:%S')}")
print(f"End:      {last_ts.strftime('%H:%M:%S')}")
print(f"Duration: {total_duration/60:.1f} minutes ({total_duration:.0f}s)")
print()

# --- Extract cost/token lines ---
session_totals = []
for line in lines:
    m = re.search(r"Session: Totals .* Director: \$([0-9.]+) .* Coder: \$([0-9.]+) .* Total: \$([0-9.]+)", line)
    if m:
        session_totals.append({
            "director": float(m.group(1)),
            "coder": float(m.group(2)),
            "total": float(m.group(3)),
        })

if session_totals:
    final = session_totals[-1]
    print("COST BREAKDOWN")
    print("-" * 40)
    print(f"Director total:  ${final['director']:.2f}  ({final['director']/final['total']*100:.0f}%)")
    print(f"Coder total:     ${final['coder']:.2f}  ({final['coder']/final['total']*100:.0f}%)")
    print(f"GRAND TOTAL:     ${final['total']:.2f}")
    print()

# --- Extract individual call metrics ---
calls = []
current_call = {}
for line in lines:
    text = line.strip()

    # Coder call completed
    m = re.search(r"Coder: Call completed \(cost: \$([0-9.]+), turns: (\d+), duration: (.+?)\)", text)
    if m:
        calls.append({
            "type": "Coder",
            "cost": float(m.group(1)),
            "turns": int(m.group(2)),
            "duration_str": m.group(3),
        })

    # Director call completed
    m = re.search(r"Director: Call completed \(cost: \$([0-9.]+), turns: (\d+), subtype: (\w+)\)", text)
    if m:
        calls.append({
            "type": "Director",
            "cost": float(m.group(1)),
            "turns": int(m.group(2)),
            "subtype": m.group(3),
        })

# Coder calls
coder_calls = [c for c in calls if c["type"] == "Coder"]
director_calls = [c for c in calls if c["type"] == "Director"]

print("CODER CALLS (the actual work)")
print("-" * 60)
print(f"{'Phase':<10} {'Cost':>8} {'Turns':>8} {'Duration':>12}")
print("-" * 60)
for i, c in enumerate(coder_calls, 1):
    print(f"Phase {i:<5} ${c['cost']:>6.2f} {c['turns']:>8} {c.get('duration_str', 'N/A'):>12}")
print("-" * 60)
total_coder_cost = sum(c["cost"] for c in coder_calls)
total_coder_turns = sum(c["turns"] for c in coder_calls)
print(f"{'TOTAL':<10} ${total_coder_cost:>6.2f} {total_coder_turns:>8}")
print()

print("DIRECTOR CALLS (planning + reviewing)")
print("-" * 60)
print(f"{'#':<5} {'Cost':>8} {'Turns':>8} {'Subtype':>15}")
print("-" * 60)
for i, c in enumerate(director_calls, 1):
    print(f"{i:<5} ${c['cost']:>6.2f} {c['turns']:>8} {c.get('subtype', 'N/A'):>15}")
print("-" * 60)
total_dir_cost = sum(c["cost"] for c in director_calls)
total_dir_turns = sum(c["turns"] for c in director_calls)
print(f"{'TOTAL':<5} ${total_dir_cost:>6.2f} {total_dir_turns:>8}")
print()

# --- Token analysis ---
token_lines = []
for line in lines:
    m = re.search(r"(Coder|Director): Tokens: in:(\d+) out:([\d.]+K?) cache-r:([\d.]+K?) cache-w:([\d.]+K?)", line)
    if m:
        def parse_k(s):
            if s.endswith("K"):
                return int(float(s[:-1]) * 1000)
            return int(s)
        token_lines.append({
            "agent": m.group(1),
            "input": parse_k(m.group(2)),
            "output": parse_k(m.group(3)),
            "cache_read": parse_k(m.group(4)),
            "cache_write": parse_k(m.group(5)),
        })

if token_lines:
    print("TOKEN USAGE")
    print("-" * 60)
    total_in = sum(t["input"] for t in token_lines)
    total_out = sum(t["output"] for t in token_lines)
    total_cache_r = sum(t["cache_read"] for t in token_lines)
    total_cache_w = sum(t["cache_write"] for t in token_lines)

    coder_tokens = [t for t in token_lines if t["agent"] == "Coder"]
    dir_tokens = [t for t in token_lines if t["agent"] == "Director"]

    print(f"{'':15} {'Input':>10} {'Output':>10} {'Cache-R':>12} {'Cache-W':>12}")
    print(f"{'Coder':15} {sum(t['input'] for t in coder_tokens):>10,} {sum(t['output'] for t in coder_tokens):>10,} {sum(t['cache_read'] for t in coder_tokens):>12,} {sum(t['cache_write'] for t in coder_tokens):>12,}")
    print(f"{'Director':15} {sum(t['input'] for t in dir_tokens):>10,} {sum(t['output'] for t in dir_tokens):>10,} {sum(t['cache_read'] for t in dir_tokens):>12,} {sum(t['cache_write'] for t in dir_tokens):>12,}")
    print(f"{'TOTAL':15} {total_in:>10,} {total_out:>10,} {total_cache_r:>12,} {total_cache_w:>12,}")
    print()

# --- Tool usage analysis ---
tool_calls = defaultdict(int)
tool_by_agent = {"Coder": defaultdict(int), "Director": defaultdict(int)}
current_agent = None
for line in lines:
    text = line.strip()
    if "Coder:" in text:
        current_agent = "Coder"
    elif "Director:" in text:
        current_agent = "Director"

    m = re.search(r"Tool: (\w+)", text)
    if m and current_agent:
        tool_name = m.group(1)
        tool_calls[tool_name] += 1
        tool_by_agent[current_agent][tool_name] += 1

print("TOOL USAGE")
print("-" * 60)
print(f"{'Tool':<25} {'Coder':>8} {'Director':>10} {'Total':>8}")
print("-" * 60)
all_tools = sorted(set(list(tool_by_agent["Coder"].keys()) + list(tool_by_agent["Director"].keys())))
for tool in all_tools:
    c = tool_by_agent["Coder"].get(tool, 0)
    d = tool_by_agent["Director"].get(tool, 0)
    print(f"{tool:<25} {c:>8} {d:>10} {c+d:>8}")
total_coder_tools = sum(tool_by_agent["Coder"].values())
total_dir_tools = sum(tool_by_agent["Director"].values())
print("-" * 60)
print(f"{'TOTAL':<25} {total_coder_tools:>8} {total_dir_tools:>10} {total_coder_tools+total_dir_tools:>8}")
print()

# --- Phase timeline ---
print("PHASE TIMELINE")
print("-" * 70)
phase_events = []
for line in lines:
    text = line.strip()
    ts = parse_ts(line)
    if not ts:
        continue

    m = re.search(r"Coder: Call starting.*phase: (\d+)", text)
    if m:
        phase_events.append(("start", int(m.group(1)), ts))

    m = re.search(r"Coder: Call completed.*duration: (.+?)\)", text)
    if m:
        phase_events.append(("coder_done", 0, ts))

    m = re.search(r"Phase (\d+) done", text)
    if m:
        phase_events.append(("phase_done", int(m.group(1)), ts))

# Compute phase durations (start of coder to phase done)
phase_times = {}
current_phase = None
for event_type, phase_num, ts in phase_events:
    if event_type == "start":
        current_phase = phase_num
        phase_times.setdefault(phase_num, {})["start"] = ts
    elif event_type == "phase_done" and phase_num in phase_times:
        phase_times[phase_num]["end"] = ts

print(f"{'Phase':<10} {'Start':>10} {'End':>10} {'Duration':>12} {'% of total':>12}")
print("-" * 70)
for p in sorted(phase_times.keys()):
    if "start" in phase_times[p] and "end" in phase_times[p]:
        dur = (phase_times[p]["end"] - phase_times[p]["start"]).total_seconds()
        pct = dur / total_duration * 100
        print(f"Phase {p:<5} {phase_times[p]['start'].strftime('%H:%M:%S'):>10} {phase_times[p]['end'].strftime('%H:%M:%S'):>10} {dur/60:>8.1f} min {pct:>10.1f}%")
print()

# --- Wasted work analysis ---
print("REWORK & WASTE INDICATORS")
print("-" * 60)

# Count failed test runs
test_fail_count = 0
test_pass_count = 0
for line in lines:
    if re.search(r"tests? (are )?(passing|passed|pass)", line, re.I):
        test_pass_count += 1
    if re.search(r"(fix|error|issue|fail|failing)", line, re.I) and "test" in line.lower():
        test_fail_count += 1

# Count TypeScript recompilations
tsc_runs = sum(1 for line in lines if "tsc" in line and "Tool:" in line)

# Count npm test runs
npm_test_runs = sum(1 for line in lines if "npm" in line and "test" in line and "Tool:" in line)

# Count port conflict issues
port_conflicts = sum(1 for line in lines if "port" in line.lower() and ("in use" in line.lower() or "already" in line.lower()))

# Count process kill attempts
kill_attempts = sum(1 for line in lines if re.search(r"(taskkill|pkill|kill)", line, re.I) and "Tool:" in line)

# Count server start attempts
server_starts = sum(1 for line in lines if re.search(r"(npm start|npm run dev|node dist|tsx src)", line) and "Tool:" in line)

# Count re-reads of same file by Director (redundant exploration)
director_reads = [line for line in lines if "Director:" in line and "Tool: Read" in line]
director_read_files = []
for line in director_reads:
    m = re.search(r"Tool: Read\((.+?)\)", line)
    if m:
        director_read_files.append(m.group(1))

from collections import Counter
read_counts = Counter(director_read_files)
redundant_reads = sum(v - 1 for v in read_counts.values() if v > 1)

print(f"TypeScript compilation runs:     {tsc_runs}")
print(f"npm test invocations:            {npm_test_runs}")
print(f"Port conflict incidents:         {port_conflicts}")
print(f"Process kill attempts:           {kill_attempts}")
print(f"Server start attempts:           {server_starts}")
print(f"Redundant Director file reads:   {redundant_reads}")
print(f"Director error_max_turns hits:   {sum(1 for c in director_calls if c.get('subtype') == 'error_max_turns')}")
print()

# --- Overhead: Director vs Coder time ---
print("OVERHEAD ANALYSIS")
print("-" * 60)

# Planning phase (before first coder call)
planning_start = first_ts
first_coder = None
for line in lines:
    if "Coder: Call starting" in line:
        first_coder = parse_ts(line)
        break

if first_coder:
    planning_time = (first_coder - planning_start).total_seconds()
    print(f"Planning phase duration:  {planning_time/60:.1f} min  ({planning_time/total_duration*100:.0f}% of total)")

# Total coder active time
coder_durations = []
for c in coder_calls:
    d = c.get("duration_str", "")
    m = re.match(r"(\d+)m (\d+)s", d)
    if m:
        coder_durations.append(int(m.group(1)) * 60 + int(m.group(2)))

total_coder_time = sum(coder_durations)
total_overhead = total_duration - total_coder_time
print(f"Total Coder active time: {total_coder_time/60:.1f} min  ({total_coder_time/total_duration*100:.0f}% of total)")
print(f"Total overhead time:     {total_overhead/60:.1f} min  ({total_overhead/total_duration*100:.0f}% of total)")
print(f"  (Director planning, reviewing, completing, gaps)")
print()

# --- Efficiency metrics ---
print("EFFICIENCY METRICS")
print("-" * 60)
print(f"Cost per phase:            ${final['total']/4:.2f}")
print(f"Cost per minute:           ${final['total']/(total_duration/60):.2f}")
print(f"Turns per phase (Coder):   {total_coder_turns/4:.0f}")
print(f"Director calls per phase:  {len(director_calls)/4:.1f}")
print(f"Director/Coder cost ratio: {final['director']/final['coder']:.2f}x")
print()

# --- Compare to hypothetical direct run ---
print("COMPARISON: ORCHESTRATOR vs DIRECT CLAUDE CODE")
print("-" * 60)
print(f"Orchestrator time:    ~{total_duration/60:.0f} min")
print(f"Orchestrator cost:    ${final['total']:.2f}")
print(f"Estimated direct:     ~6 min (user estimate)")
print(f"Estimated direct cost:~$0.50-1.00 (single session)")
print(f"Time multiplier:      ~{total_duration/60/6:.0f}x slower")
print(f"Cost multiplier:      ~{final['total']/0.75:.0f}x more expensive")
print()

print("=" * 70)
print("KEY FINDINGS")
print("=" * 70)
print("""
1. BIGGEST TIME SINK: Director reviews + functional verification
   - Director spent ~22 min reviewing/planning (37% of total time)
   - Each review starts a server, curls endpoints, fights port conflicts
   - Phase 2 review hit error_max_turns (31 turns!) without producing output

2. PORT CONFLICT CHAOS: {} port conflicts, {} kill attempts
   - Both Coder and Director try to start servers on 3333
   - Neither reliably cleans up background processes
   - Windows process management (taskkill) adds complexity

3. REDUNDANT EXPLORATION: Director re-reads files it already knows
   - {} redundant Director file reads across sessions
   - Each Director call starts fresh (no message accumulation by design)
   - The "Complete" step re-reads the entire project just to write a summary

4. CODER EFFICIENCY IS REASONABLE
   - Phase 1: 6m, $0.64 (setup from scratch - fair)
   - Phase 2: 12m, $1.86 (most complex phase - lots of debugging)
   - Phase 3: 7m, $0.60 (mostly writing HTML - efficient)
   - Phase 4: 12m, $1.62 (integration tests + debugging mocks)

5. OVER-VERIFICATION
   - 4 review cycles, 4 completion summaries, ~12 Director calls total
   - Director re-verifies things Coder already verified
   - Each Director session must re-discover the project state
""".format(port_conflicts, kill_attempts, redundant_reads))
