using SmAsia.Web.Services.Import;

namespace SmAsia.Tests;

public class SalesImportTests
{
    private static readonly DateOnly Sep27 = new(2026, 9, 27);

    [Fact]
    public void Sales_before_a_count_are_not_deducted()
    {
        var afternoonCount = new DateTime(2026, 9, 27, 14, 0, 0);
        Assert.False(SalesImporter.AfterLastCount(Sep27.AddDays(-1), afternoonCount));
        Assert.False(SalesImporter.AfterLastCount(Sep27, afternoonCount));   // end-of-day count already includes today's sales
        Assert.True(SalesImporter.AfterLastCount(Sep27.AddDays(1), afternoonCount));
    }

    [Fact]
    public void Morning_count_is_start_of_day()
    {
        Assert.True(SalesImporter.AfterLastCount(Sep27, new DateTime(2026, 9, 27, 8, 30, 0)));
    }

    [Fact]
    public void Never_counted_always_deducts() => Assert.True(SalesImporter.AfterLastCount(Sep27.AddYears(-1), null));

    [Fact]
    public void Period_is_prorated_around_the_count()
    {
        // 10 units over Sep 21–30; counted end of day Sep 25 → only Sep 26–30 (5 of 10 days) come off stock.
        var qty = SalesImporter.DeductibleQty(new DateOnly(2026, 9, 21), new DateOnly(2026, 9, 30), 10, new DateTime(2026, 9, 25, 18, 0, 0));
        Assert.Equal(5m, qty);
    }

    [Fact]
    public void Csv_parser_handles_quotes_and_blank_lines()
    {
        var rows = TabularFile.ParseDelimited("Date,Item,Qty\r\n2026-09-01,\"Rice, Jasmine 5kg\",3\r\n\r\n2026-09-02,\"He said \"\"hi\"\"\",1\r\n", ',');
        Assert.Equal(3, rows.Count);
        Assert.Equal("Rice, Jasmine 5kg", rows[1][1]);
        Assert.Equal("He said \"hi\"", rows[2][1]);
    }

    [Fact]
    public void Auto_maps_typical_epos_headers()
    {
        var map = ImportFields.AutoMap(ImportFields.Sales, ["Date", "PLU", "Description", "Qty Sold", "Net Sales", "Tax"]);
        Assert.Equal(0, map["Date"]);
        Assert.Equal(1, map["Code"]);
        Assert.Equal(2, map["Name"]);
        Assert.Equal(3, map["Quantity"]);
        Assert.Equal(4, map["Amount"]);
    }
}
