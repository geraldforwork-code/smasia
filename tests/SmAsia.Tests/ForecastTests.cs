using SmAsia.Web.Services.Forecasting;

namespace SmAsia.Tests;

public class ForecastTests
{
    private static readonly DateOnly Today = new(2026, 9, 27);

    [Fact]
    public void Steady_demand_forecasts_its_rate()
    {
        var daily = Enumerable.Repeat(4.0, 84).ToArray(); // 12 weeks of 4/day
        var f = DemandForecaster.Forecast(daily, Today.AddDays(-1));
        Assert.Equal("Trend (Holt)", f.Method);
        Assert.InRange(f.DailyRate, 3.9, 4.1);
        Assert.Equal(28, f.Sold7);
    }

    [Fact]
    public void Growing_demand_is_picked_up()
    {
        var daily = Enumerable.Range(0, 84).Select(i => 2.0 + i * 0.05).ToArray();
        var f = DemandForecaster.Forecast(daily, Today.AddDays(-1));
        Assert.True(f.Trend > 0);
        Assert.True(f.DailyRate > daily[^7..].Average() - 0.3);
    }

    [Fact]
    public void Short_history_uses_average()
    {
        var f = DemandForecaster.Forecast([1, 2, 3, 2, 2, 1, 3, 2, 2, 2], Today.AddDays(-1));
        Assert.StartsWith("Average", f.Method);
        Assert.InRange(f.DailyRate, 1.9, 2.1);
    }

    [Fact]
    public void Weekend_pattern_is_detected()
    {
        var last = new DateOnly(2026, 9, 27); // Sunday
        var start = last.AddDays(-69);
        var daily = Enumerable.Range(0, 70).Select(i => start.AddDays(i).DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? 10.0 : 2.0).ToArray();
        var f = DemandForecaster.Forecast(daily, last);
        Assert.True(f.DayOfWeekIndex[5] > 2 && f.DayOfWeekIndex[6] > 2); // Sat, Sun
        Assert.True(f.DayOfWeekIndex[0] < 1);
    }

    [Fact]
    public void Advises_whole_cases_when_below_reorder_point()
    {
        var f = DemandForecaster.Forecast(Enumerable.Repeat(2.0, 84).ToArray(), Today.AddDays(-1));
        var advice = DemandForecaster.Advise(f, new ReorderPolicy(7, 14, 1.65, 24, 0), onHand: 10, onOrder: 0, Today);
        Assert.Equal("Below reorder point", advice.Reason);
        Assert.Equal(0, advice.SuggestedUnits % 24);
        Assert.True(advice.SuggestedUnits + 10 >= 2 * 21);
        Assert.Equal(Today.AddDays(5), advice.StockoutDate);
    }

    [Fact]
    public void Stock_on_order_prevents_double_ordering()
    {
        var f = DemandForecaster.Forecast(Enumerable.Repeat(2.0, 84).ToArray(), Today.AddDays(-1));
        var advice = DemandForecaster.Advise(f, new ReorderPolicy(7, 14, 1.65, 24, 0), onHand: 10, onOrder: 48, Today);
        Assert.Equal(0, advice.SuggestedUnits);
    }

    [Fact]
    public void Min_stock_triggers_order_without_sales()
    {
        var f = DemandForecaster.Forecast([], Today.AddDays(-1));
        var advice = DemandForecaster.Advise(f, new ReorderPolicy(7, 14, 1.65, 12, 6), onHand: 2, onOrder: 0, Today);
        Assert.Equal(12, advice.SuggestedUnits);
        Assert.Equal("Below reorder point", advice.Reason);
    }
}
