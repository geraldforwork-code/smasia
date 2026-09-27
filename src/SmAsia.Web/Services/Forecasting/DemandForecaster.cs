namespace SmAsia.Web.Services.Forecasting;

public record ReorderPolicy(int LeadTimeDays, int ReviewDays, double ServiceZ, int UnitsPerCase, decimal MinStock);

public class DemandForecast
{
    public string Method { get; init; } = "No sales";
    public int HistoryDays { get; init; }
    public double DailyRate { get; init; }
    public double Sold7 { get; init; }
    public double Sold28 { get; init; }
    /// <summary>Change in weekly demand trend, e.g. 0.15 = growing 15%.</summary>
    public double? Trend { get; init; }
    public double[] WeeklyForecast { get; init; } = [];
    /// <summary>Relative day-of-week demand, Monday..Sunday; 1.0 = average day.</summary>
    public double[] DayOfWeekIndex { get; init; } = [1, 1, 1, 1, 1, 1, 1];
    public double WeeklySigma { get; init; }
}

public class ReorderAdvice
{
    public double SafetyStock { get; init; }
    public double ReorderPoint { get; init; }
    public double TargetLevel { get; init; }
    public double? DaysOfCover { get; init; }
    public DateOnly? StockoutDate { get; init; }
    public decimal SuggestedUnits { get; init; }
    public decimal SuggestedCases { get; init; }
    public string Reason { get; init; } = "";
}

/// <summary>
/// Forecasts demand from daily unit sales.
/// ≥ 6 weeks of history: Holt's damped-trend exponential smoothing on weekly totals.
/// 1–5 weeks: plain average. Day-of-week pattern is estimated once there are 8+ weeks.
/// </summary>
public static class DemandForecaster
{
    private const double Alpha = 0.35, Beta = 0.10, Phi = 0.90;

    /// <param name="daily">Units sold per day, oldest first, ending yesterday.</param>
    /// <param name="lastDay">The date of the final entry in <paramref name="daily"/>.</param>
    public static DemandForecast Forecast(double[] daily, DateOnly lastDay, int horizonWeeks = 8)
    {
        int n = daily.Length;
        double Sum(int days) => daily.Skip(Math.Max(0, n - days)).Sum();
        if (n == 0 || daily.All(d => d == 0))
            return new DemandForecast { HistoryDays = n, WeeklyForecast = new double[horizonWeeks] };

        // Whole weeks ending on the last day.
        int weeksCount = n / 7;
        var weeks = new double[weeksCount];
        for (int w = 0; w < weeksCount; w++)
            weeks[w] = daily.Skip(n - (weeksCount - w) * 7).Take(7).Sum();

        double[] forecast = new double[horizonWeeks];
        double sigma;
        string method;
        double? trend = null;

        if (weeksCount >= 6)
        {
            double level = weeks.Take(3).Average(), slope = 0, sse = 0;
            for (int t = 0; t < weeksCount; t++)
            {
                var predicted = level + Phi * slope;
                var err = weeks[t] - predicted;
                if (t >= 3) sse += err * err;
                var newLevel = Alpha * weeks[t] + (1 - Alpha) * predicted;
                slope = Beta * (newLevel - level) + (1 - Beta) * Phi * slope;
                level = newLevel;
            }
            double damp = 0;
            for (int h = 0; h < horizonWeeks; h++)
            {
                damp += Math.Pow(Phi, h + 1);
                forecast[h] = Math.Max(0, level + damp * slope);
            }
            sigma = Math.Sqrt(sse / Math.Max(1, weeksCount - 3));
            trend = level > 0 ? slope / level : null;
            method = "Trend (Holt)";
        }
        else
        {
            var weeklyMean = daily.Average() * 7;
            Array.Fill(forecast, weeklyMean);
            sigma = weeksCount >= 2 ? StdDev(weeks) : Math.Sqrt(weeklyMean); // Poisson-like when too little data
            method = weeksCount >= 1 ? "Average" : "Average (under 1 week of data)";
        }

        // Never assume less variability than a Poisson process would have.
        sigma = Math.Max(sigma, Math.Sqrt(Math.Max(forecast.FirstOrDefault(), 0)));

        var dow = new double[] { 1, 1, 1, 1, 1, 1, 1 };
        if (weeksCount >= 8)
        {
            var sums = new double[7];
            var start = lastDay.AddDays(-(n - 1));
            for (int i = 0; i < n; i++)
                sums[((int)start.AddDays(i).DayOfWeek + 6) % 7] += daily[i];
            var avg = sums.Average();
            if (avg > 0) dow = sums.Select(s => s / avg).ToArray();
        }

        return new DemandForecast
        {
            Method = method,
            HistoryDays = n,
            DailyRate = forecast[0] / 7,
            Sold7 = Sum(7),
            Sold28 = Sum(28),
            Trend = trend,
            WeeklyForecast = forecast,
            DayOfWeekIndex = dow,
            WeeklySigma = sigma,
        };
    }

    /// <summary>
    /// Periodic-review order-up-to policy: when stock position ≤ reorder point, order enough to reach
    /// demand over (lead time + review period) plus safety stock, rounded up to whole cases.
    /// </summary>
    public static ReorderAdvice Advise(DemandForecast f, ReorderPolicy policy, decimal onHand, decimal onOrder, DateOnly today)
    {
        int lead = Math.Max(0, policy.LeadTimeDays), review = Math.Max(1, policy.ReviewDays);
        int coverWeeks = (int)Math.Ceiling((lead + review) / 7.0);
        double rate = f.WeeklyForecast.Length > 0
            ? f.WeeklyForecast.Take(Math.Max(1, coverWeeks)).Average() / 7
            : f.DailyRate;

        double safety = f.DailyRate > 0 ? policy.ServiceZ * f.WeeklySigma * Math.Sqrt((lead + review) / 7.0) : 0;
        double rop = rate * lead + safety;
        double target = rate * (lead + review) + safety;
        rop = Math.Max(rop, (double)policy.MinStock);
        target = Math.Max(target, (double)policy.MinStock * 1.5);

        double position = (double)(onHand + onOrder);
        double? cover = rate > 0 ? Math.Max(0, (double)onHand) / rate : null;
        DateOnly? stockout = cover is { } c && c < 3650 ? today.AddDays((int)Math.Floor(c)) : null;

        decimal units = 0, cases = 0;
        string reason;
        if (rate <= 0 && policy.MinStock <= 0)
            reason = "No recent sales";
        else if (position <= rop || onHand < policy.MinStock)
        {
            var need = Math.Max(0, target - position);
            var upc = Math.Max(1, policy.UnitsPerCase);
            cases = (decimal)Math.Max(1, Math.Ceiling(need / upc));
            units = cases * upc;
            reason = onHand <= 0 ? "Out of stock" : position <= rop ? "Below reorder point" : "Below minimum stock";
        }
        else reason = "Stock sufficient";

        return new ReorderAdvice
        {
            SafetyStock = safety,
            ReorderPoint = rop,
            TargetLevel = target,
            DaysOfCover = cover,
            StockoutDate = stockout,
            SuggestedUnits = units,
            SuggestedCases = cases,
            Reason = reason,
        };
    }

    public static double ZForServiceLevel(double level) => level switch
    {
        >= 0.99 => 2.33,
        >= 0.98 => 2.05,
        >= 0.975 => 1.96,
        >= 0.95 => 1.65,
        >= 0.90 => 1.28,
        >= 0.85 => 1.04,
        _ => 0.84,
    };

    private static double StdDev(double[] xs)
    {
        if (xs.Length < 2) return 0;
        var mean = xs.Average();
        return Math.Sqrt(xs.Sum(x => (x - mean) * (x - mean)) / (xs.Length - 1));
    }
}
