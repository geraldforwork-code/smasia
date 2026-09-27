using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services.Parsing;

namespace SmAsia.Web.Services;

public class ReceivingService(AppDbContext db, InventoryService inventory)
{
    public async Task<Supplier> FindOrCreateSupplierAsync(IInvoiceParser parser)
    {
        var supplier = await db.Suppliers.FirstOrDefaultAsync(s => s.InvoiceParserKey == parser.Key)
                       ?? await db.Suppliers.FirstOrDefaultAsync(s => s.Name == parser.SupplierName);
        if (supplier == null)
        {
            supplier = new Supplier { Name = parser.SupplierName, InvoiceParserKey = parser.Key };
            db.Suppliers.Add(supplier);
            await db.SaveChangesAsync();
        }
        else if (supplier.InvoiceParserKey == null)
        {
            supplier.InvoiceParserKey = parser.Key;
        }
        return supplier;
    }

    public Task<Receipt?> FindDuplicateAsync(int supplierId, string? invoiceNumber) =>
        invoiceNumber == null
            ? Task.FromResult<Receipt?>(null)
            : db.Receipts.FirstOrDefaultAsync(r => r.SupplierId == supplierId && r.InvoiceNumber == invoiceNumber);

    /// <summary>Creates a draft receipt from a parsed invoice, matching each line to a product where possible.</summary>
    public async Task<Receipt> CreateFromInvoiceAsync(ParsedInvoice inv, Supplier supplier, string fileName, int? purchaseOrderId)
    {
        var matcher = await ProductMatcher.LoadAsync(db);
        var supplierItems = await db.SupplierProducts.Where(s => s.SupplierId == supplier.Id)
            .ToDictionaryAsync(s => s.SupplierItemCode.ToUpper());
        var unitsByProduct = await db.Products.ToDictionaryAsync(p => p.Id, p => p.UnitsPerCase);

        var receipt = new Receipt
        {
            SupplierId = supplier.Id,
            PurchaseOrderId = purchaseOrderId,
            InvoiceNumber = inv.InvoiceNumber,
            InvoiceDate = inv.InvoiceDate,
            SupplierOrderNumber = inv.OrderNumber,
            InvoiceSubtotal = inv.Subtotal,
            InvoiceTax = inv.Tax,
            InvoiceTotal = inv.Total,
            SourceFileName = fileName,
            Notes = inv.Warnings.Count > 0 ? string.Join("\n", inv.Warnings) : null,
        };

        int n = 1;
        foreach (var l in inv.Lines)
        {
            var match = matcher.MatchInvoiceLine(supplier.Id, l.ItemCode, l.Upc, l.Description);
            supplierItems.TryGetValue(l.ItemCode.ToUpper(), out var known);
            var units = known?.UnitsPerCase
                        ?? l.PackUnits
                        ?? (match != null && unitsByProduct.TryGetValue(match.ProductId, out var u) ? u : 1);
            receipt.Lines.Add(new ReceiptLine
            {
                LineNo = n++,
                SupplierItemCode = l.ItemCode,
                Description = l.Description,
                Upc = l.Upc,
                QtyCases = l.QtyShipped,
                UnitsPerCase = Math.Max(1, units),
                CaseCost = l.UnitCost,
                ExtendedCost = l.Extended,
                Taxable = l.Taxable,
                ProductId = match?.ProductId,
                MatchMethod = match?.Method,
                Skip = l.QtyShipped == 0,
            });
        }

        db.Receipts.Add(receipt);
        await db.SaveChangesAsync();
        return receipt;
    }

    /// <summary>Creates a draft receipt for everything still outstanding on a purchase order.</summary>
    public async Task<Receipt> CreateFromPurchaseOrderAsync(int purchaseOrderId)
    {
        var po = await db.PurchaseOrders.Include(p => p.Lines).ThenInclude(l => l.Product)
            .FirstAsync(p => p.Id == purchaseOrderId);
        var receipt = new Receipt { SupplierId = po.SupplierId, PurchaseOrderId = po.Id, Notes = $"Received against {po.PoNumber}" };
        int n = 1;
        foreach (var l in po.Lines.Where(l => l.QtyOutstandingUnits > 0))
        {
            receipt.Lines.Add(new ReceiptLine
            {
                LineNo = n++,
                ProductId = l.ProductId,
                SupplierItemCode = l.SupplierItemCode,
                Description = l.Product.Name,
                Upc = l.Product.Barcode,
                QtyCases = l.UnitsPerCase > 0 ? Math.Round(l.QtyOutstandingUnits / l.UnitsPerCase, 3) : l.QtyOutstandingUnits,
                UnitsPerCase = l.UnitsPerCase,
                CaseCost = l.CaseCost,
                ExtendedCost = Math.Round(l.QtyOutstandingUnits / Math.Max(1, l.UnitsPerCase) * l.CaseCost, 2),
                MatchMethod = "Purchase order",
            });
        }
        db.Receipts.Add(receipt);
        await db.SaveChangesAsync();
        return receipt;
    }

    /// <summary>Posts a draft receipt: adds stock, updates costs, learns supplier item codes, and updates the PO.</summary>
    public async Task<List<string>> PostAsync(int receiptId)
    {
        var errors = new List<string>();
        var receipt = await db.Receipts.Include(r => r.Lines).ThenInclude(l => l.Product)
            .Include(r => r.Supplier)
            .FirstAsync(r => r.Id == receiptId);
        if (receipt.Status == ReceiptStatus.Posted) return ["This receipt has already been posted."];

        var active = receipt.Lines.Where(l => !l.Skip).ToList();
        foreach (var l in active.Where(l => l.ProductId == null))
            errors.Add($"Line {l.LineNo} ({l.Description}) is not linked to a product. Link it, create a product, or mark it Skip.");
        foreach (var l in active.Where(l => l.QtyCases < 0 || l.UnitsPerCase < 1))
            errors.Add($"Line {l.LineNo} has an invalid quantity or units per case.");
        if (active.Count == 0) errors.Add("There are no lines to receive.");
        if (errors.Count > 0) return errors;

        await using var tx = await db.Database.BeginTransactionAsync();
        var reference = receipt.InvoiceNumber != null ? $"{receipt.Supplier.Name} {receipt.InvoiceNumber}" : $"Receipt #{receipt.Id}";
        var when = receipt.ReceivedDate.ToDateTime(TimeOnly.FromDateTime(DateTime.Now));
        var supplierItems = await db.SupplierProducts.Where(s => s.SupplierId == receipt.SupplierId).ToListAsync();

        foreach (var l in active)
        {
            var p = l.Product!;
            var units = l.QtyUnits;
            var unitCost = l.UnitsPerCase > 0 ? Math.Round(l.CaseCost / l.UnitsPerCase, 4) : l.CaseCost;
            if (units != 0) inventory.Receive(p, units, unitCost, reference, receipt.Id, when);

            if (string.IsNullOrWhiteSpace(p.Barcode) && !string.IsNullOrWhiteSpace(l.Upc) && l.Upc.Length >= 8) p.Barcode = l.Upc;
            p.UnitsPerCase = l.UnitsPerCase;
            p.PreferredSupplierId ??= receipt.SupplierId;
            if (l.ExpiryDate is { } exp && (p.NearestExpiry == null || exp < p.NearestExpiry)) p.NearestExpiry = exp;

            if (!string.IsNullOrWhiteSpace(l.SupplierItemCode))
            {
                var sp = supplierItems.FirstOrDefault(s => string.Equals(s.SupplierItemCode, l.SupplierItemCode, StringComparison.OrdinalIgnoreCase));
                if (sp == null)
                {
                    sp = new SupplierProduct { SupplierId = receipt.SupplierId, SupplierItemCode = l.SupplierItemCode };
                    db.SupplierProducts.Add(sp);
                    supplierItems.Add(sp);
                }
                sp.ProductId = p.Id;
                sp.SupplierDescription = l.Description;
                sp.UnitsPerCase = l.UnitsPerCase;
                sp.LastCaseCost = l.CaseCost;
                sp.LastReceivedOn = receipt.ReceivedDate;
            }
        }

        if (receipt.PurchaseOrderId is { } poId)
        {
            var po = await db.PurchaseOrders.Include(x => x.Lines).FirstAsync(x => x.Id == poId);
            foreach (var l in active)
            {
                var remaining = l.QtyUnits;
                foreach (var pl in po.Lines.Where(x => x.ProductId == l.ProductId && x.QtyOutstandingUnits > 0))
                {
                    var take = Math.Min(remaining, pl.QtyOutstandingUnits);
                    pl.QtyReceivedUnits += take;
                    remaining -= take;
                    if (remaining <= 0) break;
                }
            }
            po.Status = po.Lines.All(x => x.QtyOutstandingUnits <= 0) ? PurchaseOrderStatus.Received : PurchaseOrderStatus.PartiallyReceived;
        }

        receipt.Status = ReceiptStatus.Posted;
        receipt.PostedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        return errors;
    }
}
