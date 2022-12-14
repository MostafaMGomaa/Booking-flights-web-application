const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECERT, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

exports.signup = catchAsync(async (req, res, next) => {
  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
  });

  // Remove passowrd from output
  newUser.password = undefined;

  const token = signToken(newUser._id);

  res.status(201).json({
    status: 'sucess',
    token,
    data: {
      newUser,
    },
  });
});

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password)
    return next(new AppError('Please provide email and passoword', 400));

  // 1) Find user by email
  const user = await User.findOne({ email }).select('+password');

  // 2) Verify if user exists and input passsword is correct.
  if (!user || !(await user.correctPassword(password, user.password)))
    return next(new AppError('Icorrect email or password', 401));

  // 3) Send Token to client
  const token = signToken(user._id);

  res.status(200).json({
    status: 'sucess',
    token,
  });
});

exports.protect = catchAsync(async (req, res, next) => {
  /**
   * Token will sent with header called "Authorization" .
   * Authorization must start with Bearer keyword then token,
   * e.g. Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX
   */
  // 1) Getting token and check if it exists .
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token)
    return next(
      new AppError('You are not logged in! Please login for get access', 401)
    );

  // 2) Verification token
  /**
   * We promisfy verify fn beacuase all project deal with promises and to treat fn as async fn.
   * We can use callback fn with verify BTW.
   */

  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECERT);

  // 3) Check the use if still exists.
  const user = await User.findById(decoded.id);
  if (!user)
    return next(
      new AppError('The token beloning to this user does not exists', 401)
    );

  // 4) Check if user change his password after the token is issused.
  if (user.changedPasswordAfter(decoded.iat))
    return next(
      new AppError('User changed his password! please login again', 401)
    );

  // Give access to user and sent his data with req obj
  req.user = user;

  next();
});

/**
 * @param  {...String users roles which allows to access this endpoint} roles
 * @returns AppError if user cann't go there.
 */
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return next(
        new AppError(`You can't do this action as ${req.user.role}`, 403)
      );
    next();
  };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Get user by email.
  const user = await User.findOne({ email: req.body.email });

  if (!user)
    return next(
      new AppError(`Can not find this email, please input vaild email`, 400)
    );

  // 2) Generate random token.
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // 3) Send it back via email.
  const resetURL = `${req.protocol}://${req.get(
    'host'
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Submit PATCH request to ${resetURL} if you forget your password \nOherwise forget about this email.`;

  /**
   * If any error happen here it's not enough to send error,
   * We need to delete password reset token & expires
   */

  try {
    await sendEmail({
      email: user.email,
      subject: 'Your password reset token (valid for 10 min)',
      message,
    });

    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return next(
      new AppError('There was an error sending the email. Try again later!'),
      500
    );
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token.
  /**
   * ???NOTE
   * passwordResetToken was hashed in out DB
   */
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) Set the new password if user exists and  token has not expired
  if (!user)
    return next(new AppError('Token is invalied or has expired!', 400));

  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetExpires = undefined;
  user.passwordResetToken = undefined;
  await user.save();

  // 3) Update changedPasswordAt for user
  // 4) Log the user in, send JWT
  const token = signToken(user._id);

  res.status(200).json({
    status: 'sucess',
    token,
  });
});
