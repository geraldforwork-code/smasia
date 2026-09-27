using SmAsia.Web.Services.Parsing;

namespace SmAsia.Tests;

public class ProductTextTests
{
    [Theory]
    [InlineData("Reno Liver Spread 24x78g", 24)]
    [InlineData("Jack & Jill Dewberry Blueberry 20x(10x33g)", 20)]
    [InlineData("Suncrest Fudgee Barr Chocolate 10/10/42g", 10)]
    [InlineData("IndoMie Mi Goreng Regular 6x5x85g", 6)]
    [InlineData("Knorr Tamarind/SinigangSampalokSoupMix144/40g", 144)]
    [InlineData("Tatak Bulacan Citron Farms Real Calamansi Extract12/150ml", 12)]
    [InlineData("C2 Green Tea Apple 24/455ml", 24)]
    [InlineData("Knorr Tamarind With Gabi 4x(12x40g)", 4)]
    [InlineData("Some product without a pack size", null)]
    public void PackUnits(string text, int? expected) => Assert.Equal(expected, ProductText.PackUnits(text));

    [Theory]
    [InlineData("08490900040", "084909000406", true)]   // UPC printed without check digit
    [InlineData("4800016052767", "04800016052767", true)]
    [InlineData("4800016052767", "4800016052132", false)]
    [InlineData("77431", "774310256555", false)]
    public void Barcodes(string a, string b, bool match) => Assert.Equal(match, ProductText.BarcodesMatch(a, b));

    [Theory]
    [InlineData("9-28-28", 2028, 9, 28)]
    [InlineData("02/29/29", 2029, 2, 28)]
    [InlineData("09-17-26", 2026, 9, 17)]
    [InlineData("17-Sep-26", 2026, 9, 17)]
    [InlineData("Aug 04, 2026", 2026, 8, 4)]
    [InlineData("08/2027", 2027, 8, 31)]
    public void Dates(string text, int y, int m, int d) => Assert.Equal(new DateOnly(y, m, d), ProductText.ParseLooseDate(text));
}
