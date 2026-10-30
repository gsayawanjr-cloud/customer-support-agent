import { addDays } from "./dates.js";
import { parseItems, type Order, type OrderStatus } from "./store.js";

type DemoOrder = {
  orderNo: string;
  customer: string;
  email: string;
  items: string[];
  /** Days before today. */
  orderedAgo: number;
  status: OrderStatus;
  carrier?: string;
  tracking?: string;
  /** Days from today (negative = in the past). */
  etaIn?: number;
  deliveredAgo?: number;
  shipTo: string;
};

/**
 * The fake store's orders. Dates are relative to the day the store is seeded, so return windows and
 * ETAs land on the intended side of each rule. Each order backs one sample email in samples/emails.json.
 */
const DEMO_ORDERS: DemoOrder[] = [
  { orderNo: "LH-1001", customer: "Maya Chen", email: "maya.chen@example.com", items: ["2 x Linen Throw Pillow @ 38.00"], orderedAgo: 4, status: "Shipped", carrier: "UPS", tracking: "1Z84X7W60312458871", etaIn: 2, shipTo: "742 Alder Ave, Seattle, WA 98103" },
  { orderNo: "LH-1002", customer: "Jordan Ellis", email: "jordan.ellis@example.com", items: ["1 x Walnut Serving Board @ 64.00", "1 x Ceramic Table Lamp @ 89.00"], orderedAgo: 16, status: "Delivered", carrier: "FedEx", tracking: "771204588193", deliveredAgo: 10, shipTo: "19 Birch Ln, Denver, CO 80206" },
  { orderNo: "LH-1003", customer: "Priya Raman", email: "priya.raman@example.com", items: ["1 x Wool Area Rug 5x7 @ 249.00"], orderedAgo: 52, status: "Delivered", carrier: "UPS", tracking: "1Z84X7W60398811020", deliveredAgo: 45, shipTo: "3300 Cedar St, Apt 4B, Chicago, IL 60614" },
  { orderNo: "LH-1004", customer: "Sam Okafor", email: "sam.okafor@example.com", items: ["1 x Stoneware Dinner Set Clearance @ 72.00 [FINAL SALE]"], orderedAgo: 11, status: "Delivered", carrier: "USPS", tracking: "9400111899223344556677", deliveredAgo: 6, shipTo: "88 Magnolia Dr, Atlanta, GA 30307" },
  { orderNo: "LH-1005", customer: "Lena Fischer", email: "lena.fischer@example.com", items: ["1 x Glass Pendant Light @ 129.00"], orderedAgo: 8, status: "Delivered", carrier: "FedEx", tracking: "771204590041", deliveredAgo: 3, shipTo: "510 Spruce Ct, Madison, WI 53703" },
  { orderNo: "LH-1006", customer: "Carlos Mendes", email: "carlos.mendes@example.com", items: ["1 x Oak Bookshelf @ 199.00"], orderedAgo: 1, status: "Processing", etaIn: 6, shipTo: "18 Pine St, Austin, TX 78701" },
  { orderNo: "LH-1007", customer: "Hannah Brooks", email: "hannah.brooks@example.com", items: ["1 x Velvet Accent Chair @ 329.00"], orderedAgo: 3, status: "Shipped", carrier: "FedEx", tracking: "771204591187", etaIn: 3, shipTo: "2201 Willow Rd, Nashville, TN 37203" },
  { orderNo: "LH-1008", customer: "Theo Nguyen", email: "theo.nguyen@example.com", items: ["3 x Beeswax Pillar Candle @ 18.00"], orderedAgo: 1, status: "Processing", etaIn: 5, shipTo: "67 Laurel St, San Diego, CA 92101" },
  { orderNo: "LH-1009", customer: "Ava Patel", email: "ava.patel@example.com", items: ["1 x Cotton Duvet Cover Queen @ 119.00"], orderedAgo: 18, status: "Delivered", carrier: "UPS", tracking: "1Z84X7W60377120944", deliveredAgo: 12, shipTo: "45 Hawthorn Pl, Boston, MA 02116" },
  { orderNo: "LH-1010", customer: "Noah Kim", email: "noah.kim@example.com", items: ["1 x Rattan Wall Mirror @ 145.00"], orderedAgo: 1, status: "Processing", etaIn: 7, shipTo: "900 Elm Ave, Portland, OR 97205" },
  { orderNo: "LH-1011", customer: "Grace Liu", email: "grace.liu@example.com", items: ["1 x Teak Side Table @ 159.00"], orderedAgo: 14, status: "Delivered", carrier: "FedEx", tracking: "771204593360", deliveredAgo: 8, shipTo: "12 Sycamore Way, Phoenix, AZ 85004" },
  { orderNo: "LH-1012", customer: "Ben Carter", email: "ben.carter@example.com", items: ["1 x Marble Coasters Set of 4 @ 32.00"], orderedAgo: 9, status: "Delivered", carrier: "USPS", tracking: "9400111899223344559911", deliveredAgo: 5, shipTo: "301 Poplar St, Columbus, OH 43215" },
  { orderNo: "LH-1013", customer: "Olivia Grant", email: "olivia.grant@example.com", items: ["1 x Woven Storage Basket @ 42.00", "2 x Linen Napkins Set of 6 @ 34.00"], orderedAgo: 5, status: "Shipped", carrier: "FedEx", tracking: "771204594472", etaIn: 1, shipTo: "77 Juniper Rd, Raleigh, NC 27601" },
  { orderNo: "LH-1014", customer: "Ethan Ross", email: "ethan.ross@example.com", items: ["1 x Brass Candle Holder @ 26.00"], orderedAgo: 6, status: "Cancelled", shipTo: "5 Chestnut St, Richmond, VA 23220" },
  { orderNo: "LH-1015", customer: "Mia Torres", email: "mia.torres@example.com", items: ["1 x Jute Doormat @ 28.00", "1 x Linen Table Runner @ 36.00"], orderedAgo: 26, status: "Delivered", carrier: "UPS", tracking: "1Z84X7W60311007735", deliveredAgo: 20, shipTo: "1400 Aspen Blvd, Salt Lake City, UT 84111" },
];

/** Sheet rows for the Orders tab (same column order as ORDERS_TABLE). */
export function demoOrderRows(today: string): string[][] {
  return DEMO_ORDERS.map((o) => [
    o.orderNo,
    o.customer,
    o.email,
    o.items.join("\n"),
    addDays(today, -o.orderedAgo),
    o.status,
    o.carrier ?? "",
    o.tracking ?? "",
    o.etaIn !== undefined ? addDays(today, o.etaIn) : "",
    o.deliveredAgo !== undefined ? addDays(today, -o.deliveredAgo) : "",
    o.shipTo,
    "",
  ]);
}

/** The same orders as typed objects, for the offline self-test. */
export function demoOrders(today: string): Order[] {
  return demoOrderRows(today).map((r, i) => ({
    row: i + 2,
    orderNo: r[0]!,
    customer: r[1]!,
    email: r[2]!,
    items: parseItems(r[3]!),
    itemsText: r[3]!,
    orderDate: r[4]!,
    status: r[5] as OrderStatus,
    carrier: r[6]!,
    tracking: r[7]!,
    eta: r[8]!,
    deliveredDate: r[9]!,
    shipTo: r[10]!,
  }));
}
