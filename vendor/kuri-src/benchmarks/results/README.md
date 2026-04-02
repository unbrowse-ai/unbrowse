# Results

Timestamped benchmark captures live in this folder.

Latest run:

- [`20260327-111817-https_www.google.com_travel_flights_q=Flights%20to%20TPE%20from%/summary.md`](/Users/rachpradhan/kuri/benchmarks/results/20260327-111817-https_www.google.com_travel_flights_q=Flights%20to%20TPE%20from%/summary.md)
- [`20260327-111817-https_www.google.com_travel_flights_q=Flights%20to%20TPE%20from%/summary.json`](/Users/rachpradhan/kuri/benchmarks/results/20260327-111817-https_www.google.com_travel_flights_q=Flights%20to%20TPE%20from%/summary.json)

Recommended reference runs:

- Vercel:
  [`20260327-111742-https_vercel.com/summary.md`](/Users/rachpradhan/kuri/benchmarks/results/20260327-111742-https_vercel.com/summary.md)
- Google Flights:
  [`20260327-111817-https_www.google.com_travel_flights_q=Flights%20to%20TPE%20from%/summary.md`](/Users/rachpradhan/kuri/benchmarks/results/20260327-111817-https_www.google.com_travel_flights_q=Flights%20to%20TPE%20from%/summary.md)

Reproduce:

```bash
./benchmarks/run_token_matrix.sh https://vercel.com
./benchmarks/run_token_matrix.sh "https://www.google.com/travel/flights?q=Flights%20to%20TPE%20from%20SIN%20on%202026-03-23&curr=SGD"
```
