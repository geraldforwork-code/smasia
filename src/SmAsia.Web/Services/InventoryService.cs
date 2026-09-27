using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Services;

/// <summary>The only place on-hand stock changes; every change writes a StockMovement.</summary>
public class InventoryService(AppDbContext db)
{
    public StockMovement Move(Product product, MovementType type, decimal quantity, string? reference = null, string? note = null,
        DateTime? when = null, decimal? unitCost = null, int? receiptId = null, int? importBatchId = null)
    {
        product.QtyOnHand += quantity;
        product.UpdatedAt = DateTime.UtcNow;
        var m = new StockMovement
        {
            Product = product,
            Type = type,
            Quantity = quantity,
            QtyAfter = product.QtyOnHand,
            OccurredAt = when ?? DateTime.Now,
            Reference = reference,
            Note = note,
            UnitCost = unitCost,
            ReceiptId = receiptId,
            ImportBatchId = importBatchId,
        };
        db.StockMovements.Add(m);
        return m;
    }

    /// <summary>Records a stock count; returns null when the count matches what is on hand.</summary>
    public StockMovement? SetCount(Product product, decimal counted, string? reference = null, string? note = null, int? importBatchId = null)
    {
        var delta = counted - product.QtyOnHand;
        if (delta == 0) return null;
        return Move(product, MovementType.Count, delta, reference ?? "Stock count", note, importBatchId: importBatchId);
    }

    /// <summary>Receives stock at a cost, updating the weighted average unit cost.</summary>
    public StockMovement Receive(Product product, decimal units, decimal unitCost, string reference, int receiptId, DateTime when)
    {
        var existing = Math.Max(0, product.QtyOnHand);
        product.UnitCost = existing + units > 0 && product.UnitCost > 0
            ? Math.Round((existing * product.UnitCost + units * unitCost) / (existing + units), 4)
            : unitCost;
        return Move(product, MovementType.Receipt, units, reference, when: when, unitCost: unitCost, receiptId: receiptId);
    }
}
