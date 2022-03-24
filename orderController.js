const { useDB, sendError, createExcel, randomNumber, checkAccess ,getClientDiscount,compareDates} = require('../../services/helper')

var validate = require('../../config/messages');
const fs = require('fs');
const moment = require('moment');
const { connect } = require('mongodb');
const Analytics = require('./analyticsController');
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    auth: {
        user: '*********',
        pass: '***********',
    },
});
async function sumProductQuantity(sizes=[]){
    let sum = 0;
    sum = sizes.reduce(function (acc,val){return acc+val.quantity},0)
    return sum;
}
async function checkAndSendWarning(client,cashback_model,transporter,bonus_history_model,company){
    let users = useDB('loygift');
    let personal_model = users.model("User");
    let user = await personal_model.findById(company);


    if(!client || !cashback_model || !bonus_history_model || !transporter || !user){
        return;
    }

    let histories = await bonus_history_model.find({client:client._id,createdAt:{
        $gte: new Date(new Date().setHours(0o0, 0o0, 0o0)),
        $lt: new Date(new Date().setHours(23, 59, 59))
    }});
    try {
        let cashback = await cashback_model.find();
        let first_cashback = cashback[0];
        if (first_cashback) {
            if(first_cashback.minScans.status &&  histories.length>=first_cashback.minScans.number){
                //send message
                let  message =  `
                    client: ${client.name}, scanned QR code ${histories.length} times
                `;
                transporter.sendMail({
                    from: 'loygift', // sender address
                    to: user.email, // list of receivers
                    subject: "Suspicious activities", // Subject line
                    html: "<b>" + message + " </b>", // html body
                }).catch(console.error);
            }
        }
    }catch (e) {
        console.log(e);
    }


}



async function cancelOrDeleteOrder(ClientBonusHistory,Product,cashback_model,client,order){
    //subtract cashback, balance, add cashback used to client, create new bonus history
    await createClientHistory(
        ClientBonusHistory,
        client,
        order.points,
        `Points refunded, order # ${order.code}`,
        order._id,
        "received",
        -parseFloat(order.totalPrice),
    );
    //deduct cashback/points that client had received
    //and cashback/points is received only on -> done
    if(order.status === 'Done'){
        let products = order.productsDetails.map(function (item){
            return {id:item.product._id,quantity:item.quantity}
        })
        let result_object = await products_with_discounts(
            products,   // list of product ids $ quant
            Product,     // Product model
            order.promoCodeObject,   // promocode object
            order.statusDiscount,// discount object or null
        );
        let cashback_from_order = await calcCashback(result_object.productCurrentPrice,cashback_model);
        await createClientHistory(
            ClientBonusHistory,
            client,
            cashback_from_order,
            `Points cancelled, order # ${order.code}`,
            order._id,
            "deducted",
            0,
        );
    }
}
async function createClientHistory(ClientBonusHistory,client,points=0,source='',order_id=null,type,balance=0){
    //ClientBonusHistory - model
    //client             - object
    //points             - num
    //source             - Points cancelled order #' + updated_order.code
    //order_id           - id can be null
    //type               - used,deducted,received
    //balance            - balance -> order's sum can be negative or positive
    if(client){
        if(parseFloat(balance)!=0){
            client.balance = (parseFloat(client.balance) + parseFloat(balance)).toFixed(2);
        }

        if(parseFloat(points)>0){
            if(['used','deducted'].includes(type)){
                client.points = (parseFloat(client.points) - parseFloat(points)).toFixed(2);
            }else if(['received'].includes(type)){
                client.points = (parseFloat(client.points) + parseFloat(points)).toFixed(2);
            }
            await new ClientBonusHistory({
                client: client._id,
                points: points,
                source: source,
                order: order_id,
                type: type,
            }).save();
        }
        await client.save({ validateBeforeSave: false });
    }




}

// function compareDates(dateStart_,dateEnd_,editDate_=null){
//     if(!dateStart_ || !dateEnd_){
//         return false;
//     }
//     let today = editDate_ ? moment(editDate_) : moment();
//     let dateStart = moment(dateStart_);
//     let dateEnd = moment(dateEnd_);
//     //(start<=today<=end)
//     return(dateStart.isSameOrBefore(today,'day') && dateEnd.isSameOrAfter(today,'day'))
// }
async function products_with_discounts(products=[],Product,promocode=null,discount_obj=null,editDate_=null) {
    //params: product->list of products ids and quantity, Product model,promocode obj,client obj,discounts list.
    //stuff that can affect the price
    //1 items own discount, 2 promo, 3 clients status
    let nonDiscountedTotal = 0;
    let discountedTotal = 0;
    let discountsTotal = 0;
    let productCurrentPrice = [];
    let statusDiscount = {name:'',discount_percentage:0}
    for (const product of products) {
        let product_obj = await Product.findById(product.id ?? product._id);
        if(!product_obj){
            continue;
        }
        let temp = {
            name:'',
            current_price:0,
            old_price:0,
            quantity:0,
            product:{},
            discounted:false,
            discountType:'',
            size:{
                _id:"",
            }
        }
        temp.product = product_obj;
        temp.quantity = parseFloat(product.quantity)
        let orderItemPrice = parseFloat(product_obj.price);
        //check if product has multiple types/sizes
        if(product_obj.hasMultipleTypes && product.size._id !== ''){
            orderItemPrice = parseFloat(product.size.price);
            temp.size = product.size;
        }

        //check if its an old order
        if(product.useOldPrice){
            temp.current_price = parseFloat(product.oldPrice);
            temp.discounted = true;
            temp.discountType='own';
            temp.name = product_obj.name;
            temp.old_price= orderItemPrice;
            productCurrentPrice.push(temp);
            continue
        }

        //check products own discount
        if(compareDates(product_obj.promoStart,product_obj.promoEnd,editDate_)){
            temp.current_price = parseFloat(product_obj.promoPrice);
            temp.discounted = true;
            temp.discountType='own';
            temp.name = product_obj.name;
            temp.old_price= orderItemPrice;
        }else{
            temp.name = product_obj.name;
            temp.old_price= orderItemPrice;
            temp.current_price = orderItemPrice;
        }
        //check the promo
        if(!temp.discounted){
            if(promocode){
                //assume that promo is already validated
                if(promocode.selected_type==="all" || promocode.selected_items_list.includes(product_obj._id.toString())){
                    let non_discounted = orderItemPrice;
                    let discount_percent = non_discounted*(parseFloat(promocode.discount)/100);
                    let discount_sum = parseFloat(promocode.fixed_sum);
                    let sum = (non_discounted-discount_percent-discount_sum).toFixed(2); //its a string
                    temp.current_price = parseFloat(sum)>0 ? parseFloat(sum) : 0;
                    temp.discounted = true;
                    temp.discountType='promocode';
                    temp.old_price= orderItemPrice;
                }
            }
        }
        //check clients discount
        if(!temp.discounted){
            if(discount_obj && discount_obj.discount_percentage){
                statusDiscount.name = discount_obj.name;
                statusDiscount.discount_percentage = discount_obj.discount_percentage;
                let non_discounted = orderItemPrice;
                let discount_percent = non_discounted*(parseFloat(discount_obj.discount_percentage)/100);
                temp.current_price = non_discounted-discount_percent; //its a string
                temp.discounted = true;
                temp.discountType='clientStatus';
                temp.old_price= orderItemPrice;
            }
        }
        productCurrentPrice.push(temp);
    }
    //Counting
    productCurrentPrice.forEach(function (prod){
        nonDiscountedTotal = parseFloat(nonDiscountedTotal) + (parseFloat(prod.old_price)*parseFloat(prod.quantity));
        discountedTotal = parseFloat(discountedTotal) + (parseFloat(prod.current_price)*parseFloat(prod.quantity));
    })
    discountsTotal = nonDiscountedTotal-discountedTotal;
    //return each product discounted
    //return total sum non-discounted, total sum discounted, total discounts
    return {
        productCurrentPrice:productCurrentPrice,
        nonDiscountedTotal:nonDiscountedTotal.toFixed(2),
        discountedTotal:discountedTotal.toFixed(2),
        discountsTotal:discountsTotal.toFixed(2),
        statusDiscount:statusDiscount,
    }
}

async function calcCashback(products_full_data,cashback_model) {
    //Cashback
    //1 check if cashback is active,2 check if applies to everything or
    //specific products,3 if all -apply & end ,else check if products match
    let cashback_from_order = 0;
    if(!products_full_data){
        return 0;
    }
    try {
        let cashback = await cashback_model.find();
        let first_cashback = cashback[0];
        if (first_cashback) {
            //1
            let cashback_status = first_cashback.status;
            let cashback_default_percent = parseFloat(first_cashback.default_cashback) / 100;
            if (!cashback_status) {
                return;
            }
            //2
            let cashback_products = first_cashback.selectedItemsList;
            //3
            if (cashback_products.length === 0) {
                //applies to all
                products_full_data.forEach(function (prod) {
                    //discounted price
                    let sum = prod.current_price || 0;
                    let quantity = prod.quantity || 0;
                    cashback_from_order += (parseFloat(sum) * quantity * cashback_default_percent).toFixed(2);
                })
            } else {
                //applies to specific products
                products_full_data.forEach(function (prod) {
                    //check
                    cashback_products.forEach(function (cash) {
                        if (prod.product._id == cash.id) {
                            //discounted price
                            let sum = prod.current_price || 0;
                            let quantity = prod.quantity || 0;
                            let cashback_percent = parseFloat(cash.percentage_cashback) / 100 || 0;
                            let cashback_sum = cash.fixed_cashback || 0;
                            cashback_from_order = (parseFloat(cashback_from_order) + (parseFloat(sum) * quantity * cashback_percent) + parseFloat(cashback_sum)).toFixed(2);
                        }
                    })
                })
            }

        }
    } catch (e) {
        console.log(e);
    }
    return cashback_from_order;
}
async function checkAndUpdatePromo(promocode=null,client=null) {
    if(promocode){
        // promocode.usedBy = [];
        // promocode.save();
        // console.log(promocode);
        // return;

        //check uses
        if(promocode.already_used >= promocode.number_of_uses){
            return res.status(400).send("Promocode has expired");
        }
        promocode.already_used +=1;
        let usedBy = promocode.usedBy;
        if(client){
            let exists = usedBy.find(used => used.user == client._id.toString());
            if(!exists){
                usedBy.push({
                    user:client._id,
                    quantity:1,
                    name:client.name,
                })
            }else{
                exists.quantity +=1;
            }
        }else{
            let exists = usedBy.find(used => used.user == null);
            if(!exists){
                usedBy.push({
                    user:null,
                    quantity:1,
                })
            }else{
                exists.quantity +=1;
            }
        }
        promocode.save();
    }
}
class OrderController{
    
    getOrder = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active" }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Sending order'
        }
        try {
            let order = await Order.findById(req.params.order)
            result['object'] = await order.populate('client').populate('products').execPopulate()
        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }

        res.status(result.status).json(result);
    };

    getOrders = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        let result = {
            'status': 200,
            'msg': 'Sending orders'
        }
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active" }, db, res)
            if (checkResult) {
                return;
            }
        }
        try {
            let query = {}
            if (req.query.client) {
                query = { 'client': req.query.client }
            }
            let orders = {}
            if (req.query.populate == "client"){
                // orders = await Order.find(query).populate('client').populate('products').exec();
                orders = await Order.find(query).sort({ updatedAt: -1 }).populate('client').populate({path:'products',populate: { path: 'product', model: 'Product' }}).exec();
            }else{
                orders = await Order.find(query).sort({ updatedAt: -1 }).populate('products').exec()
            }
            
            result['objects'] = orders
        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }
        res.status(result.status).json(result);
    };

    addOrder = async function (req, res) {
        // console.log("start")
        // const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
        // await delay(5000) /// waiting 1 second.

        let db = useDB(req.db)
        let Order = db.model("Order");
        let Client = db.model("Client");  
        let Product = db.model("Product");
        let OrderProduct = db.model("OrderProduct");
        let Log = db.model("Log");
        let ClientBonusHistory = db.model("clientBonusHistory");
        let DeliveryModel = db.model("Delivery");
        let Discount = db.model("Discount");
        let PromocodeModel = db.model("Promocode");
        let Branch = db.model("Branch");
        let lang = req.headers["accept-language"]
        if (lang != 'ru') {
            lang = 'en'
        }
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active", parametr2: 'canEdit' }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Order added'
        }

        order_try: try {
            let discounts = await Discount.find();
            let client = await Client.findById(req.fields.client);
            let discount_obj = getClientDiscount(client,discounts);
            if (req.fields.promoCode == "") {
                req.fields.promoCode = null;
            }
            let promocode = await PromocodeModel.findById(req.fields.promoCode);
            let delivery = await DeliveryModel.findById(req.fields.delivery);
            let branch = await Branch.findById(req.fields.branch);
            let deliveryPrice = 0;
            if(delivery){
                deliveryPrice = delivery.price;
            }

            //params: product->list of products ids and quantity, Product model,promocode obj,client obj,discounts list.
            let result_object = await products_with_discounts(
                req.fields.products, // list of product ids and quant
                Product,             // Product model
                promocode,           // promocode object
                discount_obj,        // discount object or null
            );

            let total = (parseFloat(result_object.discountedTotal) + parseFloat(deliveryPrice) - parseFloat(req.fields.points || 0)).toFixed(2);
            let totalDiscount = result_object.discountsTotal;
            //personal discount

            if(req.fields.personalDiscount && req.fields.personalDiscount.hasOwnProperty('sum') && req.fields.personalDiscount.hasOwnProperty('percent')){
                let personalDiscountSum = parseFloat(req.fields.personalDiscount.sum || 0);
                if(req.fields.personalDiscount.percent){
                    let discount = parseFloat(total)  * personalDiscountSum / 100;
                    total = (parseFloat(total)  - discount).toFixed(2);
                    totalDiscount = (parseFloat(totalDiscount) + discount).toFixed(2);
                }else{
                    let discount = personalDiscountSum;
                    total = (parseFloat(total) - discount).toFixed(2);
                    totalDiscount = (parseFloat(totalDiscount) + discount).toFixed(2);
                }
            }

            //update promocode
            await checkAndUpdatePromo(promocode,client);
            let order = await new Order({
                 // client: client._id,
                 // client_name: client.name,
                 // client_phone: client.phone,
                // waiter_id: "129B5752-F2EC-487E-8655-E1D6E9847BC7",
                // waiter_name: "sdfasdfasdfasd",
                qr_code: req.fields.qr_code,
                statusDiscount:result_object.statusDiscount,
                promoCode: req.fields.promoCode,
                promoCodeObject: promocode,
                status: req.fields.status,
                address: req.fields.address,
                delivery: req.fields.delivery,
                deliveryObject: delivery,
                deliveryType: req.fields.deliveryType,
                notes: req.fields.notes,
                points: req.fields.points || 0,
                code: randomNumber(100000, 10000000),
                deliveryPrice: deliveryPrice,
                totalDiscount: totalDiscount,
                productsPrice: result_object.nonDiscountedTotal,
                totalPrice: total,
                branch: req.fields.branch,
                branchObject: branch,
                products:[],
                personalDiscount:req.fields.personalDiscount,
                productsDetails:result_object.productCurrentPrice,
            });

            var products = req.fields.products
            for(let i=0; i < products.length; i++){
                let product = products[i]
                let search_product = await Product.findById(product.id)
                if(!product.id){
                    search_product = await Product.findById(product._id)
                }
                if (search_product) {
                    let order_product = await new OrderProduct({
                        product: product.id ? product.id : product._id,
                        name: search_product.name,
                        name_ru: search_product.name_ru,
                        secondary: search_product.secondary,
                        secondary_ru: search_product.secondary_ru,
                        img: search_product.img,
                        price: search_product.price,
                        quantity: product.quantity
                    }).save();
                    order.products.push(order_product._id);

                    if(search_product.hasMultipleTypes && product.size && product.size._id){
                        let index123 = search_product.sizes.findIndex(x => x._id.toString() === product.size._id.toString());
                        if(index123 !== -1){
                            search_product.sizes[index123].quantity = parseFloat(search_product.sizes[index123].quantity)-parseFloat(product.quantity);
                            search_product.quantity = await sumProductQuantity(search_product.sizes);
                        }
                    }else{
                        search_product.quantity = parseFloat(search_product.quantity)-parseFloat(product.quantity);
                    }
                    search_product.save();
                }else{
                    return res.status(400).send(`Out of stock, ${search_product.name} only ${search_product.quantity} left`);
                    // break order_try;
                }
                //send warning
            }

            if(client){
                if (req.fields.points){
                    client.points -= req.fields.points;
                    client.save({ validateBeforeSave: false });
                    await new ClientBonusHistory({
                        client: client._id,
                        points: req.fields.points,
                        source: 'Points used order #'+order.code,
                        order: order._id,
                        type: 'used',
                    }).save();
                }
                client.balance = (parseFloat(client.balance) +parseFloat(order.totalPrice)).toFixed(2);
                await client.save({ validateBeforeSave: false });

                order.client=client._id;
                order.client_name=client.name;
                order.client_phone=client.phone;

            }else if(req.fields.guest){
                let guest = req.fields.guest;
                order.client_name=guest.name || '';
                order.client_phone=guest.phone || '';
            }
            await new Log({
                type: "order_created",
                description: "order_num",
                value: "#" + order.code,
                user: req.userName,
                user_id: req.userID,
                icon: "add"
            }).save()

            await order.save();
            result['object'] = await order.populate('products').execPopulate();
        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }
        res.status(result.status).json(result);
    };

    getEarnedPoints = async function (req, res) {
        let db = useDB(req.db)
        let cashback_model = db.model("Cashback");
        let products_full_data = req.fields.products_full_data;
        let result = await calcCashback(products_full_data,cashback_model);
        res.status(200).json(result);
    }
    updateOrder = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        let Product = db.model("Product");
        let OrderProduct = db.model("OrderProduct");
        let Log = db.model("Log");
        let Discount = db.model("Discount");
        let PromocodeModel = db.model("Promocode");
        let Client = db.model("Client");
        let ClientBonusHistory = db.model("clientBonusHistory");
        let DeliveryModel = db.model("Delivery");
        let Branch = db.model("Branch");
        let cashback_model = db.model("Cashback");

        if (req.userType == "employee" && Object.keys(req.fields).length == 1 && "status" in req.fields){
            let checkResult = await checkAccess(req.userID, { access: "canChangeOrderStatus" }, db, res)
            if (checkResult) {
                return;
            }
        }
        if (req.userType == "employee" && "status" in req.fields) {
            let checkResult = await checkAccess(req.userID, { access: "canChangeOrderStatus" }, db)
            if (checkResult) {
                delete req.fields.status;
            }
        }
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active", parametr2: 'canEdit' }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Order updated',
        }
        try {
            //order has to use the old clients status discount if its the same client
            //old product price if it was discounted at that time
            //old promocode is used if unchanged
            //old delivery is used if unchanged
            let query = { '_id': req.params.order }
            let products = req.fields.products;
            let promocode = await PromocodeModel.findById(req.fields.promoCode);
            let old_order = req.fields.old_order;
            let old_products = old_order.productsDetails;
            let new_products  = req.fields.products;
            let new_array = [];
            new_products.forEach(function (new_p){
                let obj = {
                    id:new_p.id,
                    quantity:new_p.quantity,
                    useOldPrice:false,
                    oldPrice:0,
                };
                old_products.forEach(function (old_p){
                    if(old_p.product._id === new_p.id && old_p.discounted && old_p.discountType === "own"){
                        obj.useOldPrice = true;
                        obj.oldPrice = old_p.current_price;
                    }
                })
                new_array.push(obj);
            })
            let discount_obj = old_order.statusDiscount;
            let delivery_obj = old_order.deliveryObject;
            let discounts = await Discount.find();
            let branch = await Branch.findById(req.fields.branch);
            let deliveryPrice = 0;

            if(old_order.delivery != req.fields.delivery){
                delivery_obj = await DeliveryModel.findById(req.fields.delivery);
            }

            if(delivery_obj){
                deliveryPrice = delivery_obj.price;
            }
            //Get sums
            let result_object = await products_with_discounts(
                new_array,   // list of product ids $ quant
                Product,     // Product model
                promocode,   // promocode object
                discount_obj,// discount object or null
            );

            let total = (parseFloat(result_object.discountedTotal) + parseFloat(deliveryPrice) - parseFloat(req.fields.points || 0)).toFixed(2);
            let totalDiscount = result_object.discountsTotal;
            //personal discount
            if(req.fields.personalDiscount && req.fields.personalDiscount.hasOwnProperty('sum') && req.fields.personalDiscount.hasOwnProperty('percent')){
                let personalDiscountSum = parseFloat(req.fields.personalDiscount.sum || 0);
                if(req.fields.personalDiscount.percent){
                    let discount = parseFloat(total)  * personalDiscountSum / 100;
                    total = (parseFloat(total)  - discount).toFixed(2);
                    totalDiscount = (parseFloat(totalDiscount) + discount).toFixed(2);
                }else{
                    let discount = personalDiscountSum;
                    total = (parseFloat(total) - discount).toFixed(2);
                    totalDiscount = (parseFloat(totalDiscount) + discount).toFixed(2);
                }
            }

            //Client Related
            //1 old guest to new guest  -> nothing
            //2 old guest to new client -> subtract points, add balance from/to new client
            //3 old client to new guest -> add points, subtract balance from/to old client
            //4 old client unchanged but new sums -> add/subtract points, add/subtract balance from/to old client
            //5 old client to new client -> subtract points, add balance from/to new client
            //                            add points, subtract balance from/to old client

            let old_client = null;
            let new_client = null;
            //used points
            //leave unchanged, add or subtract points
            let old_points = parseFloat(old_order.points);
            let new_points = parseFloat(req.fields.points);
            let diff_points = new_points - old_points;

            //balance
            let old_total = parseFloat(old_order.totalPrice);
            let diff_total = parseFloat(total)-old_total;

            if(old_order.client){
                old_client = await Client.findById(old_order.client._id);
            }
            new_client = await Client.findById(req.fields.client);
            if(!old_client && !new_client){
                //1 old guest to new guest  -> nothing
            }
            if(!old_client && new_client){
                //2 old guest to new client -> subtract points, add balance from/to new client
                await createClientHistory(
                    ClientBonusHistory,
                    new_client,
                    new_points,
                    `Points used order # ${old_order.code}`,
                    old_order._id,
                    "used",
                    total
                );
            }
            if(old_client && !new_client){
                //3 old client to new guest -> add points, subtract balance from/to old client
                await createClientHistory(
                    ClientBonusHistory,
                    old_client,
                    old_order.points,
                    `Points refunded in update order # ${old_order.code}`,
                    old_order._id,
                    "received",
                    -parseFloat(old_order.totalPrice),
                );
            }

            if((old_client && new_client) && (old_client._id.toString() == new_client._id.toString())){
                //4 old client unchanged but new sums -> add/subtract points, add/subtract balance from/to old client
                //check points and total
                if (diff_points > 0){
                    //used points have increased
                    await createClientHistory(
                        ClientBonusHistory,
                        old_client,
                        diff_points,
                        `Points used in update order # ${old_order.code}`,
                        old_order._id,
                        "used",
                        0,
                    );
                }else if(diff_points < 0){
                    //used points have decreased
                    await createClientHistory(
                        ClientBonusHistory,
                        old_client,
                        diff_points,
                        `Points refunded in update order # ${old_order.code}`,
                        old_order._id,
                        "received",
                        0,
                    );
                }
                //balance
                await createClientHistory(
                    ClientBonusHistory,
                    old_client,
                    0,
                    ``,
                    old_order._id,
                    "received",
                    diff_total
                );
            }else{
                //5 old client to new client -> subtract points, add balance from/to new client
                //                            add points, subtract balance from/to old client
                await createClientHistory(
                    ClientBonusHistory,
                    old_client,
                    old_order.points,
                    `Points refunded in update order # ${old_order.code}`,
                    old_order._id,
                    "received",
                    -parseFloat(old_order.totalPrice),
                );

                await createClientHistory(
                    ClientBonusHistory,
                    new_client,
                    new_points,
                    `Points used order # ${old_order.code}`,
                    old_order._id,
                    "used",
                    total
                );
            }

            let data = {
                updatedAt:new Date(),
                statusDiscount:result_object.statusDiscount, ///need old
                promoCode: req.fields.promoCode,
                promoCodeObject: promocode, ///need old
                status: req.fields.status,
                address: req.fields.address,
                delivery: req.fields.delivery,
                deliveryObject: delivery_obj, ///need old
                deliveryType: req.fields.deliveryType,
                notes: req.fields.notes,
                points: req.fields.points || 0,
                code: randomNumber(100000, 10000000),
                deliveryPrice: deliveryPrice,
                totalDiscount: totalDiscount,
                productsPrice: result_object.nonDiscountedTotal,
                totalPrice: total,
                branch: req.fields.branch,
                branchObject: branch,
                products:[],
                personalDiscount:req.fields.personalDiscount,
                productsDetails:result_object.productCurrentPrice,
            }
            if(new_client){
                data.client=new_client._id;
                data.client_name=new_client.name;
                data.client_phone=new_client.phone;
            }else if(req.fields.guest){
                let guest = req.fields.guest;
                data.client_name=guest.name || '';
                data.client_phone=guest.phone || '';
            }

            let order = await Order.findOneAndUpdate(query, data);
            await checkAndUpdatePromo(promocode,new_client);

            if(products && products.length){
                order.products = []
                for (let i = 0; i < products.length; i++) {
                    let product = products[i]
                    let search_product = await Product.findById(product.id)
                    if (!product.id) {
                        search_product = await Product.findById(product._id)
                    }
                    if (search_product) {
                        let order_product = await new OrderProduct({
                            product: search_product._id,
                            name: search_product.name,
                            name_ru: search_product.name_ru,
                            secondary: search_product.secondary,
                            secondary_ru: search_product.secondary_ru,
                            img: search_product.img,
                            price: search_product.price,
                            quantity: product.quantity
                        }).save();

                        order.products.push(order_product._id)
                    }
                }
                await order.save()
            }
            let status = req.fields.status.replace(/ /g, '').toLowerCase()
            var logVal = {
                type: "order_updated",
                title: "#" + order.code,
                description: "order_changed",
                user: req.userName,
                user_id: req.userID,
                icon: "update"
            }
            if (req.fields.status && Object.keys(req.fields).length == 2){
                logVal.description = "status_changed"
                logVal.valueColor = status
                logVal.value = status
            }
            await new Log(logVal).save()
            await Analytics.updateAnalytics(req, order.createdAt, true)

            result['object'] = await order.populate('client').populate('products').execPopulate()
        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }
        res.status(result.status).json(result);
    };
    updateOrderStatus = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        let Product = db.model("Product");
        let Log = db.model("Log");
        let Client = db.model("Client");
        let ClientBonusHistory = db.model("clientBonusHistory");
        let cashback_model = db.model("Cashback");

        if (req.userType == "employee" && Object.keys(req.fields).length == 1 && "status" in req.fields){
            let checkResult = await checkAccess(req.userID, { access: "canChangeOrderStatus" }, db, res)
            if (checkResult) {
                return;
            }
        }
        if (req.userType == "employee" && "status" in req.fields) {
            let checkResult = await checkAccess(req.userID, { access: "canChangeOrderStatus" }, db)
            if (checkResult) {
                delete req.fields.status;
            }
        }
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active", parametr2: 'canEdit' }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Order updated',
        }
        try {
            let query = { '_id': req.params.order }
            req.fields['updatedAt'] = new Date();
            let order = await Order.findOneAndUpdate(query, req.fields);
            let updated_order = await Order.findById(order._id);
            let client = await Client.findById(order.client);
            let products = updated_order.productsDetails.map(function (item){
                return {id:item.product._id,quantity:item.quantity}
            })
            let result_object = await products_with_discounts(
                products,   // list of product ids $ quant
                Product,     // Product model
                updated_order.promoCodeObject,// promocode object
                updated_order.statusDiscount,// discount object or null
            );
            let cashback_from_order = await calcCashback(result_object.productCurrentPrice,cashback_model);
            if(updated_order.status === "Done" && client){
                updated_order.earnedPoints = parseFloat(cashback_from_order) || 0;
                await updated_order.save();
                await createClientHistory(
                    ClientBonusHistory,
                    client,
                    cashback_from_order,
                    `Points received order # ${updated_order.code}`,
                    updated_order._id,
                    "received",
                    0
                );
            }
            if(updated_order.status === "Cancelled" && client){
                //subtract cashback, balance, add cashback used to client, create new bonus history
                await createClientHistory(
                    ClientBonusHistory,
                    client,
                    updated_order.points,
                    `Points refunded, order # ${updated_order.code}`,
                    updated_order._id,
                    "received",
                    -parseFloat(updated_order.totalPrice),
                );
                if(updated_order.status === 'Done') {
                    await createClientHistory(
                        ClientBonusHistory,
                        client,
                        cashback_from_order,
                        `Points cancelled, order # ${updated_order.code}`,
                        updated_order._id,
                        "deducted",
                        0,
                    );
                }
            }
        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }
        res.status(result.status).json(result);
    };
    deleteOrder = async function (req, res) {
        let db = useDB(req.db);
        let Order = db.model("Order");
        let Log = db.model("Log");
        let ClientBonusHistory = db.model("clientBonusHistory");
        let Client = db.model("Client");
        let cashback_model = db.model("Cashback");
        let Product = db.model("Product");
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active", parametr2: 'canEdit' }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Order deleted'
        }
        try {
            let query = { '_id': req.params.order }
            let order = await Order.findById(query)
            if(order){
                let client = await Client.findById(order.client);
                await new Log({
                    type: "order_deleted",
                    title: "#" + order.code,
                    description: "order_by",
                    value: order.client_name,
                    user: req.userName,
                    user_id: req.userID,
                    icon: "delete"
                }).save()
                await Analytics.updateAnalytics(req, order.createdAt, true)
                //client related
                if(client){
                    await cancelOrDeleteOrder(ClientBonusHistory, Product, cashback_model, client, order);
                }
            }
            await Order.findByIdAndRemove(query)
        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }
        res.status(result.status).json(result);
    };

    deleteOrders = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        let Log = db.model("Log");
        let ClientBonusHistory = db.model("clientBonusHistory");
        let Client = db.model("Client");
        let cashback_model = db.model("Cashback");
        let Product = db.model("Product");
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active", parametr2: 'canEdit' }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Orders deleted'
        }
        if (req.fields.objects.length) {
            try {
                let query = {
                    '_id': {
                        $in: req.fields.objects
                    }
                }
                // let orders = await Order.find(query, 'code');
                let orders = await Order.find(query);
                if (orders.length) {
                    let desc = orders.map(function (elem) {
                        return "#" + elem.code;
                    }).join(", ")
                    await Analytics.updateAnalytics(req, orders[0].createdAt, true)
                    await new Log({
                        type: "orders_deleted",
                        description: desc,
                        user: req.userName,
                        user_id: req.userID,
                        icon: "delete"
                    }).save()

                }
                for (const order of orders) {
                    let client = await Client.findById(order.client);
                    if(client){
                        await cancelOrDeleteOrder(ClientBonusHistory, Product, cashback_model, client, order);
                    }
                }
                await Order.deleteMany(query)
            } catch (error) {
                result = sendError(error, req.headers["accept-language"])
            }
        } else {
            result = {
                'status': 200,
                'msg': 'Parametr objects is empty'
            }
        }


        res.status(result.status).json(result);
    };
    getOrderExcel = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active"}, db, res)
            if (checkResult) {
                return;
            }
        }
        let lang = req.headers["accept-language"]
        if (lang != 'ru') {
            lang = 'en'
        }
        let result = {
            'status': 200,
            'msg': 'Sending link'
        }
        try {
            let objects = await Order.find().where('_id').in(req.fields.objects).populate('client').populate('products').exec()
            createExcel("order", objects, lang, req.db)
            let file = 'https://localhost:8443/files/' + req.db + '/Excel.xlsx'
            result['object'] = file
        } catch (error) {
            result = sendError(error, lang)
        }

        res.status(result.status).json(result);
    };
    addOderPoints = async function (req, res) {
        let db = useDB(req.db)
        let Order = db.model("Order");
        let Log = db.model("Log");
        let ClientBonusHistory = db.model("clientBonusHistory");
        let Client = db.model("Client");
        let cashback_model = db.model("Cashback");
        let Product = db.model("Product");
        if (req.userType == "employee") {
            let checkResult = await checkAccess(req.userID, { access: "orders", parametr: "active", parametr2: 'canEdit' }, db, res)
            if (checkResult) {
                return;
            }
        }
        let result = {
            'status': 200,
            'msg': 'Points were transferred',
        };
        try {
            let order = await Order.findById(req.fields.orderId);
            let clients = await Client.find({uniqueCode:req.fields.clientCode});
            let client = null;
            if(clients.length>0){
                client = clients[0];
            }else{
                return res.status(400).send(`Client not found`);
            }

            if(!order){
                return res.status(400).send(`Orders not found`);
            }
            if(order.status === "Cancelled"){
                return res.status(400).send(`Orders is already cancelled`);
            }

            let products = order.productsDetails.map(function (item){
                return {id:item.product._id,quantity:item.quantity}
            })
            let result_object = await products_with_discounts(
                products,   // list of product ids $ quant
                Product,     // Product model
                order.promoCodeObject,// promocode object
                order.statusDiscount,// discount object or null
            );
            await checkAndSendWarning(client, cashback_model, transporter, ClientBonusHistory,req.db.slice(7));

            let cashback_from_order = await calcCashback(result_object.productCurrentPrice,cashback_model);
            await createClientHistory(
                ClientBonusHistory,
                client,
                cashback_from_order,
                `Points received order # ${order.code}`,
                order._id,
                "received",
                0
            );
            result['pointsAdded'] = cashback_from_order;
            order.pointsStatus.received = true;
            order.pointsStatus.amount = cashback_from_order;
            await order.save();

        } catch (error) {
            result = sendError(error, req.headers["accept-language"])
        }
        res.status(result.status).json(result);

    }
}


module.exports = new OrderController();
