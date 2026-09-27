using SmAsia.Web.Services.Parsing;

namespace SmAsia.Tests;

public class InvoiceParserTests
{
    private static readonly InvoiceParserRegistry Registry = new([new UnoFoodsInvoiceParser(), new DongPhuongInvoiceParser()]);

    private static ParsedInvoice Parse(string file)
    {
        using var fs = File.OpenRead(TestFiles.Path(file));
        var (inv, err) = Registry.Parse(fs);
        Assert.Null(err);
        return inv!;
    }

    [Fact]
    public void UnoFoods_header_and_totals()
    {
        var inv = Parse("unofoods-IN89529.pdf");
        Assert.Equal("unofoods", inv.ParserKey);
        Assert.Equal("IN00089529", inv.InvoiceNumber);
        Assert.Equal(new DateOnly(2026, 8, 4), inv.InvoiceDate);
        Assert.Equal("OR00086374", inv.OrderNumber);
        Assert.Equal("DRY", inv.CustomerPo);
        Assert.Equal(4119.73m, inv.Subtotal);
        Assert.Equal(61.67m, inv.Tax);
        Assert.Equal(4181.40m, inv.Total);
        Assert.Equal(inv.Subtotal, inv.LinesTotal);
        Assert.Equal(75, inv.Lines.Sum(l => l.QtyShipped));
        Assert.Empty(inv.Warnings);
    }

    [Fact]
    public void UnoFoods_lines()
    {
        var inv = Parse("unofoods-IN89529.pdf");
        var reno = inv.Lines.Single(l => l.ItemCode == "DREN-002");
        Assert.Equal(2, reno.QtyShipped);
        Assert.Equal(68.64m, reno.UnitCost);
        Assert.Equal(137.28m, reno.Extended);
        Assert.Equal("774310300203", reno.Upc);
        Assert.Equal(24, reno.PackUnits);
        Assert.Equal("Reno Liver Spread 24x78g", reno.Description);

        var maxx = inv.Lines.Single(l => l.ItemCode == "DJAC-034");
        Assert.Equal("4800016306013", maxx.Upc);
        Assert.Equal(40, maxx.PackUnits);

        Assert.True(inv.Lines.Single(l => l.ItemCode == "DJAC-071").Taxable);
        Assert.False(reno.Taxable);
        Assert.Equal(20, inv.Lines.Single(l => l.ItemCode == "DJAC-078").PackUnits);
    }

    [Fact]
    public void DongPhuong_header_and_totals()
    {
        var inv = Parse("dongphuong-IN10073256.pdf");
        Assert.Equal("dongphuong", inv.ParserKey);
        Assert.Equal("IN10073256", inv.InvoiceNumber);
        Assert.Equal(new DateOnly(2026, 9, 17), inv.InvoiceDate);
        Assert.Equal("ORD0109257", inv.OrderNumber);
        Assert.Equal(1335.85m, inv.Subtotal);
        Assert.Equal(18.65m, inv.Tax);
        Assert.Equal(1354.50m, inv.Total);
        Assert.Equal(16, inv.Lines.Count);
        Assert.Equal(1335.85m, inv.LinesTotal);
        Assert.Equal(18.65m, inv.Lines.Sum(l => l.Tax));
        Assert.Empty(inv.Warnings);
    }

    [Fact]
    public void DongPhuong_lines()
    {
        var inv = Parse("dongphuong-IN10073256.pdf");
        var tapioca = inv.Lines[0];
        Assert.Equal("11026", tapioca.ItemCode);
        Assert.Equal("Cock Brand Tapioca Pearl Small 50/400g", tapioca.Description);
        Assert.Equal("CS", tapioca.Uom);
        Assert.Equal("08490900040", tapioca.Upc);
        Assert.Equal(110m, tapioca.UnitCost);
        Assert.Equal(50, tapioca.PackUnits);

        var tamarind = inv.Lines.Single(l => l.ItemCode == "53142D");
        Assert.Equal(2, tamarind.QtyShipped);
        Assert.Equal(35m, tamarind.UnitCost);
        Assert.Equal(70m, tamarind.Extended);

        var sugo = inv.Lines.Single(l => l.ItemCode == "41083010");
        Assert.Equal(1.60m, sugo.Tax);
        Assert.True(sugo.Taxable);
    }
}
